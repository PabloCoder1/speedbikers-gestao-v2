-- D-879: a sugestão de compra calculada só para os SKUs pedidos.
--
-- get_purchase_analysis (pedido novo, com a sugestão ligada) chamava
-- get_purchase_suggestions para o catálogo inteiro e ficava com ~50 linhas. Em
-- produção, a sugestão do catálogo custa de 0,75 a 1,0 s, e uma página custa o
-- mesmo, porque tudo é calculado antes do limit.
--
-- get_purchase_suggestions ganha p_sku_ids, opcional e no fim. Nulo, nada
-- muda para as outras chamadas (Reposição, contagem de estados, alcance,
-- sugestão do pedido e Copiloto). Com a lista, a conta por SKU (saldos, Full,
-- vendas do ML e da Shopee e a linha do SKU) fica restrita a ela. A curva ABC,
-- o histórico de 90 dias e a loja Shopee lida continuam sendo os do catálogo
-- inteiro, então a sugestão de cada SKU é a mesma. A demanda da Shopee passa a
-- ler os itens antes do pedido, com o mesmo recorte.
--
-- Um parâmetro novo muda a assinatura: a função é apagada e recriada, com o
-- comentário e os grants de antes. Nenhum objeto depende dela no catálogo
-- (pg_depend vazio em produção), e quem a chama é plpgsql ou SQL não atômico,
-- por posição, com até sete argumentos.

drop function public.get_purchase_suggestions(uuid, date, text, text, integer, integer, text);

CREATE FUNCTION public.get_purchase_suggestions(p_organization_id uuid, p_date_to date, p_supplier_brand text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_state text DEFAULT NULL::text, p_sku_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(sku_id uuid, sku text, title text, supplier_brand text, purchase_cost numeric, stock_is_virtual boolean, local_quantity numeric, reservado numeric, transito numeric, full_quantity numeric, units_15d bigint, units_30d bigint, units_60d bigint, units_90d bigint, history_days_90 bigint, abc_class text, coverage_days numeric, state text, suggested_quantity integer, total_count bigint, units_30d_shopee bigint, units_90d_shopee bigint)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
#variable_conflict use_column
begin
  return query

  with janela as (
    -- `p_date_to` NULO passa a significar HOJE, e nao NADA (D-280).
    --
    -- Antes, um nulo aqui fazia toda comparacao de data virar NULL: as CTEs
    -- `trend_windows` e `history` nao casavam UMA linha, `units_90d` saia 0
    -- para o catalogo inteiro, e a recusa `units_90d < 12` (D-147) reprovava
    -- todo mundo. O resultado eram 3.284 SKUs devolvidos, TODOS sem estado --
    -- indistinguivel de "nada se qualifica hoje".
    --
    -- Foi essa leitura que me fez diagnosticar uma regressao inexistente em
    -- 2026-09-09. A funcao estava certa; o silencio e que nao estava. Zero
    -- nao pode ser a resposta para "voce nao me disse a data" (D-067).
    select coalesce(p_date_to, current_date) as ate
  ),
  shopee_lida as (
    -- C-65 (D-459): ha loja Shopee live com pedidos ja lidos? Sem ela, as colunas
    -- da Shopee saem NULAS (ausencia nao e zero); com ela, 0 quando o SKU nao vendeu.
    select exists (
      select 1 from public.shopee_shops s
      where s.organization_id = p_organization_id
        and s.environment = 'live'
        and s.orders_synced_until is not null
    ) as lida
  ),
  -- D-879: os itens Shopee saem primeiro, pelo índice (organization_id,
  -- sku_id) quando há p_sku_ids, e só então encontram o pedido. Pela view
  -- shopee_sales_items, o filtro de organização caía no pedido, e o plano
  -- provava os itens de cada pedido válido. Item, pedido e loja têm a mesma
  -- organização pelas chaves estrangeiras, então o recorte é o mesmo.
  itens_shopee as materialized (
    select i.shopee_shop_id, i.order_sn, i.sku_id, i.quantity
    from public.shopee_order_items i
    where i.organization_id = p_organization_id
      and i.sku_id is not null
      and (p_sku_ids is null or i.sku_id = any (p_sku_ids))
  ),
  shopee as materialized (
    -- C-65 (D-459): a demanda da Shopee -- unidades dos itens de vendas
    -- VALIDAS (5S, a definicao mora em shopee_sales_orders) das lojas LIVE, por
    -- SKU e dia de Sao Paulo. A loja de teste nunca entra.
    select it.sku_id, v.dia, sum(it.quantity)::bigint as unidades
    from itens_shopee it
    join public.shopee_sales_orders v
      on v.shopee_shop_id = it.shopee_shop_id and v.order_sn = it.order_sn
    where v.organization_id = p_organization_id
      and v.environment = 'live'
      and v.situacao = 'VALIDA'
      and v.dia > (select ate from janela) - 90
      and v.dia <= (select ate from janela)
    group by it.sku_id, v.dia
  ),
  pivot as (
    select b.sku_id,
      sum(b.quantity) filter (where b.location_kind = 'LOCAL')     as local_quantity,
      sum(b.quantity) filter (where b.location_kind = 'RESERVADO') as reservado,
      sum(b.quantity) filter (where b.location_kind = 'TRANSITO')  as transito
    from public.inventory_balances b
    where b.organization_id = p_organization_id
      and (p_sku_ids is null or b.sku_id = any (p_sku_ids))
    group by b.sku_id
  ),
  full_por_sku as (
    -- Definicao CANONICA de "Full atual" (D-173), agora a MESMA de
    -- `get_stock_balances`, `get_sku_abc_curve` e `get_fulfillment_overview`:
    -- um saldo por BUCKET (`inventory_id`), com janela de frescor de 3 dias.
    --
    -- O que estava aqui era `where captured_at = max(captured_at)`, e o
    -- proprio D-173 ja tinha registrado por que isso e' furado: `captured_at`
    -- e carimbado UMA vez no inicio da varredura, mas as ~500 linhas de cada
    -- conta entram ao longo de **312 a 395 segundos**. Durante esses ~6
    -- minutos, duas vezes por dia por conta, esta consulta via so a fracao ja
    -- gravada -- Full menor do que e', e a sugestao de compra pedindo MAIS do
    -- que precisa. Sem janela de frescor, uma captura que falhasse deixaria
    -- Full arbitrariamente velho passar por atual, sem sinal nenhum.
    --
    -- Medido em 02/09/2026, antes de trocar: as duas formas devolvem
    -- exatamente o mesmo numero (648 SKUs, 7.873 unidades). A divergencia e'
    -- LATENTE, nao ativa -- ela acende nas duas condicoes acima.
    select q.sku_id, sum(q.quantity) as full_quantity
    from (
      select distinct on (f.ml_account_id, f.inventory_id) f.sku_id, f.quantity
      from public.fulfillment_stock_snapshots f
      where f.organization_id = p_organization_id
        and f.captured_at >= now() - interval '3 days'
        -- D-879: com p_sku_ids, só os buckets que tiveram algum daqueles SKUs
        -- na janela. Um bucket cuja captura mais recente é de um SKU pedido
        -- está entre eles; os outros sairiam no recorte abaixo de qualquer
        -- jeito. O distinct on continua escolhendo a captura mais recente.
        and (p_sku_ids is null or (f.ml_account_id, f.inventory_id) in (
          select g.ml_account_id, g.inventory_id
          from public.fulfillment_stock_snapshots g
          where g.organization_id = p_organization_id
            and g.captured_at >= now() - interval '3 days'
            and g.sku_id = any (p_sku_ids)))
      order by f.ml_account_id, f.inventory_id, f.captured_at desc
    ) q
    -- D-879: o recorte por SKU vem DEPOIS do distinct on, para que o saldo de
    -- cada bucket continue sendo o da captura mais recente dele.
    where p_sku_ids is null or q.sku_id = any (p_sku_ids)
    group by q.sku_id
  ),
  trend_ml as (
    select m.sku_id,
      coalesce(sum(m.units_sold) filter (where m.metric_date > (select ate from janela) - 15), 0)::bigint as units_15d,
      coalesce(sum(m.units_sold) filter (where m.metric_date > (select ate from janela) - 30), 0)::bigint as units_30d,
      coalesce(sum(m.units_sold) filter (where m.metric_date > (select ate from janela) - 60), 0)::bigint as units_60d,
      coalesce(sum(m.units_sold), 0)::bigint as units_90d
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and (p_sku_ids is null or m.sku_id = any (p_sku_ids))
      and m.metric_date > (select ate from janela) - 90
      and m.metric_date <= (select ate from janela)
    group by m.sku_id
  ),
  trend_shopee as (
    select sh.sku_id,
      coalesce(sum(sh.unidades) filter (where sh.dia > (select ate from janela) - 15), 0)::bigint as u15,
      coalesce(sum(sh.unidades) filter (where sh.dia > (select ate from janela) - 30), 0)::bigint as u30,
      coalesce(sum(sh.unidades) filter (where sh.dia > (select ate from janela) - 60), 0)::bigint as u60,
      coalesce(sum(sh.unidades), 0)::bigint as u90
    from shopee sh
    group by sh.sku_id
  ),
  trend_windows as (
    -- As janelas somam o ML e a Shopee: a venda/dia (30d), a recusa de 12 em
    -- 90d e a sugestao passam a ver a demanda dos dois marketplaces (C-65).
    select coalesce(m.sku_id, s.sku_id) as sku_id,
      coalesce(m.units_15d, 0) + coalesce(s.u15, 0) as units_15d,
      coalesce(m.units_30d, 0) + coalesce(s.u30, 0) as units_30d,
      coalesce(m.units_60d, 0) + coalesce(s.u60, 0) as units_60d,
      coalesce(m.units_90d, 0) + coalesce(s.u90, 0) as units_90d,
      s.u30 as shopee_30d,
      s.u90 as shopee_90d
    from trend_ml m
    full outer join trend_shopee s on s.sku_id = m.sku_id
  ),
  history as (
    select count(distinct m.metric_date)::bigint as history_days_90
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date > (select ate from janela) - 90
      and m.metric_date <= (select ate from janela)
  ),
  abc as (
    -- Reuso da curva canonica (D-140): criterio faturamento, 90d TRAILING
    -- encerrados na janela -- a mesma do units_90d acima.
    select a.sku_id, a.abc_class
    from public.get_sku_abc_curve(
      p_organization_id, (select ate from janela) - 89, (select ate from janela),
      null, 'faturamento', false, 2147483647, 0
    ) a
  ),
  combined as (
    select coalesce(p.sku_id, t.sku_id) as sku_id,
      p.local_quantity, p.reservado, p.transito,
      t.units_15d, t.units_30d, t.units_60d, t.units_90d, t.shopee_30d, t.shopee_90d
    from pivot p
    full outer join trend_windows t on t.sku_id = p.sku_id
  ),
  settings as (
    select * from public.replenishment_settings s
    where s.organization_id = p_organization_id
  ),
  base as (
    select sk.id as sku_id, sk.sku, sk.title, sk.supplier_brand, sk.purchase_cost,
      sk.stock_is_virtual,
      coalesce(c.local_quantity, 0) as local_quantity,
      coalesce(c.reservado, 0) as reservado,
      coalesce(c.transito, 0) as transito,
      coalesce(fp.full_quantity, 0) as full_quantity,
      coalesce(c.units_15d, 0) as units_15d,
      coalesce(c.units_30d, 0) as units_30d,
      coalesce(c.units_60d, 0) as units_60d,
      coalesce(c.units_90d, 0) as units_90d,
      case when (select sl.lida from shopee_lida sl) then coalesce(c.shopee_30d, 0) end as shopee_30d,
      case when (select sl.lida from shopee_lida sl) then coalesce(c.shopee_90d, 0) end as shopee_90d,
      ab.abc_class,
      -- Precedencia de LINHA INTEIRA: o escopo que venceu fornece TODOS os
      -- campos, inclusive um max_coverage_days nulo.
      case
        when s_sku.id is not null then s_sku.lead_time_days
        when s_brand.id is not null then s_brand.lead_time_days
        else s_org.lead_time_days
      end as lead_time_days,
      case
        when s_sku.id is not null then s_sku.target_coverage_days
        when s_brand.id is not null then s_brand.target_coverage_days
        else s_org.target_coverage_days
      end as target_coverage_days,
      case
        when s_sku.id is not null then s_sku.safety_stock_days
        when s_brand.id is not null then s_brand.safety_stock_days
        else s_org.safety_stock_days
      end as safety_stock_days,
      case
        when s_sku.id is not null then s_sku.max_coverage_days
        when s_brand.id is not null then s_brand.max_coverage_days
        else s_org.max_coverage_days
      end as max_coverage_days,
      (s_sku.id is not null or s_brand.id is not null or s_org.id is not null) as has_policy
    from public.skus sk
    left join combined c on c.sku_id = sk.id
    left join full_por_sku fp on fp.sku_id = sk.id
    left join abc ab on ab.sku_id = c.sku_id
    left join settings s_sku   on s_sku.sku_id = sk.id
    left join settings s_brand on s_brand.supplier_brand = sk.supplier_brand and s_brand.sku_id is null
    left join settings s_org   on s_org.supplier_brand is null and s_org.sku_id is null
    -- Full atual positivo também torna o SKU elegível, mesmo sem linha em
    -- inventory_balances nem venda na janela. A recusa por falta de amostra permanece.
    where sk.organization_id = p_organization_id
      -- D-860: o SKU fora do catálogo do UpSeller não entra na Reposição.
      and sk.erp_absent_since is null
      -- D-879: com p_sku_ids, só aqueles SKUs. A curva ABC e o histórico de
      -- 90 dias continuam sendo os do catálogo inteiro.
      and (p_sku_ids is null or sk.id = any (p_sku_ids))
      and (c.sku_id is not null or fp.full_quantity > 0)
      and (p_supplier_brand is null or sk.supplier_brand = p_supplier_brand)
      and (p_search is null
           or sk.sku   ilike '%' || p_search || '%'
           or sk.title ilike '%' || p_search || '%')
  ),
  computed as (
    select b.*, h.history_days_90,
      b.units_30d / 30.0 as rate,
      case when b.stock_is_virtual then null
           else b.local_quantity + b.full_quantity + b.transito end as usable
    from base b
    cross join history h
  ),
  verdict as (
    select c.*,
      -- As quatro recusas da sugestao (D-147), como flag unica.
      (not c.has_policy
        or c.usable is null
        or c.history_days_90 < 84
        or c.units_90d < 12) as refused,
      case when c.usable is null or c.rate <= 0 then null
           else round(greatest(c.usable, 0) / c.rate, 1) end as coverage_days
    from computed c
  ),
  -- ------------------------------------------------------------
  -- O estado sobe para CTE (D-250), e a razao e poder filtrar por ele.
  --
  -- Antes o `case` vivia no `select` final, onde nao ha como aplicar um
  -- `where` em cima. A contagem tambem sai do `count(*) over ()` para
  -- subconsulta independente sobre o conjunto FILTRADO -- o desenho que D-167
  -- aprovou depois do EXPLAIN reprovar a janela.
  --
  -- A ORDEM de prioridade de D-150 NAO mudou: virou a coluna `prioridade`,
  -- calculada uma vez em vez de repetida dentro do `order by`.
  -- ------------------------------------------------------------
  classificada as (
    select v.*,
      case
        when v.refused or v.rate <= 0 then null
        when v.usable <= 0 then 'RUPTURA'
        when v.coverage_days <= v.lead_time_days then 'COMPRA_URGENTE'
        when v.coverage_days <= v.lead_time_days + v.safety_stock_days then 'COMPRAR_EM_BREVE'
        when v.coverage_days < v.lead_time_days + v.target_coverage_days + v.safety_stock_days then 'COBERTURA_BAIXA'
        when v.max_coverage_days is not null and v.coverage_days > v.max_coverage_days then 'EXCESSO'
        else 'ADEQUADA'
      end as estado,
      case when v.refused then null
           else greatest(
             0,
             ceil(
               ceil((v.lead_time_days + v.target_coverage_days + v.safety_stock_days) * v.rate)
               - v.usable
             )
           )::integer
      end as sugestao,
      case
        when v.refused or v.rate <= 0 then 4
        when v.usable <= 0 then 0
        when v.coverage_days <= v.lead_time_days then 1
        when v.coverage_days <= v.lead_time_days + v.safety_stock_days then 2
        when v.coverage_days < v.lead_time_days + v.target_coverage_days + v.safety_stock_days then 3
        when v.max_coverage_days is not null and v.coverage_days > v.max_coverage_days then 6
        else 5
      end as prioridade
    from verdict v
  ),
  filtrada as (
    select * from classificada c
    where p_state is null
       or (p_state = 'SEM_ESTADO' and c.estado is null)
       or c.estado = p_state
  )
  select
    f.sku_id, f.sku, f.title, f.supplier_brand, f.purchase_cost,
    f.stock_is_virtual, f.local_quantity, f.reservado, f.transito,
    f.full_quantity, f.units_15d, f.units_30d, f.units_60d, f.units_90d,
    f.history_days_90, f.abc_class, f.coverage_days,
    f.estado as state,
    f.sugestao as suggested_quantity,
    (select count(*) from filtrada) as total_count,
    f.shopee_30d::bigint,
    f.shopee_90d::bigint
  from filtrada f
  order by
    f.prioridade,
    case f.abc_class when 'A' then 0 when 'B' then 1 when 'C' then 2 else 3 end,
    f.coverage_days asc nulls last,
    f.units_30d desc,
    f.sku
  limit greatest(p_limit, 0) offset greatest(p_offset, 0);
end
$function$;

comment on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer, text, uuid[]) is
  'Sugestao de compra (D-147/D-150): janelas de venda = ML + Shopee (vendas validas das lojas live, C-65/D-459), venda/dia de 30 dias, recusas, estado e sugestao sobre o total; units_30d_shopee/units_90d_shopee mostram a parte da Shopee (NULA sem loja live com pedidos lidos). p_sku_ids (D-879) restringe a conta por SKU a uma lista; a curva ABC e o historico seguem do catalogo inteiro. security invoker.';
revoke all on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer, text, uuid[]) from public, anon;
grant execute on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer, text, uuid[]) to authenticated, service_role;

create or replace function public.get_purchase_analysis(
  p_organization_id uuid,
  p_sku_ids uuid[],
  p_date_to date default null,
  p_exclude_order_id uuid default null,
  p_supplier_id uuid default null,
  -- Falso = só os extras: a Reposição já tem os ingredientes da sugestão na
  -- linha da visão e não paga a segunda varredura do catálogo.
  p_incluir_sugestao boolean default true
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  v_ate date := coalesce(p_date_to, (now() at time zone 'America/Sao_Paulo')::date);
begin
  if coalesce(cardinality(p_sku_ids), 0) > 500 then
    raise exception 'no maximo 500 skus por leitura';
  end if;

  if coalesce(cardinality(p_sku_ids), 0) = 0 then
    return jsonb_build_object('data', v_ate, 'linhas', '[]'::jsonb,
      'new_product_days', coalesce((select r.new_product_days from public.purchase_review_settings r where r.organization_id = p_organization_id), 60),
      'margem_minima', coalesce((select t.margin_floor from public.central_thresholds t where t.organization_id = p_organization_id), 0.10));
  end if;

  return (
  with
  alvo as materialized (
    select s.id as sku_id, s.sku, s.title, s.supplier_brand, s.purchase_cost,
           s.created_at, s.is_discontinued, s.stock_is_virtual, s.kind
    from public.skus s
    where s.organization_id = p_organization_id
      and s.id = any (p_sku_ids)
  ),
  sugestao as materialized (
    select o.*
    -- D-879: só os SKUs pedidos. A sugestão de cada um não muda; a função
    -- deixa de calcular o catálogo inteiro para devolver ~50 linhas.
    from public.get_purchase_suggestions(p_organization_id, v_ate, null, null, 1000000, 0, null,
      array(select a.sku_id from alvo a)) o
    where coalesce(p_incluir_sugestao, true)
      and o.sku_id in (select a.sku_id from alvo a)
  ),
  -- D-878: os itens Shopee dos SKUs pedidos saem primeiro pelo índice
  -- (organization_id, sku_id) e só então encontram o pedido. Pela view
  -- shopee_sales_items, o filtro de organização caía no pedido, e o plano
  -- percorria todos os pedidos válidos da loja para provar os itens de cada um.
  -- A organização do item é a da loja, e a do pedido também (chaves
  -- estrangeiras por loja e organização), então o recorte é o mesmo.
  itens_shopee as materialized (
    select i.shopee_shop_id, i.order_sn, i.sku_id
    from public.shopee_order_items i
    where i.organization_id = p_organization_id
      and i.sku_id in (select a.sku_id from alvo a)
  ),
  primeira_venda as (
    select x.sku_id, min(x.dia) as dia
    from (
      -- D-878: o primeiro dia com venda no ML sai do índice
      -- (organization_id, sku_id, metric_date), e não de todos os dias do SKU.
      select a.sku_id, ml.dia
      from alvo a
      cross join lateral (
        select m.metric_date as dia
        from public.daily_sku_metrics m
        where m.organization_id = p_organization_id
          and m.sku_id = a.sku_id
          and m.units_sold > 0
        order by m.metric_date
        limit 1
      ) ml
      union all
      select it.sku_id, min(v.dia)
      from itens_shopee it
      join public.shopee_sales_orders v
        on v.shopee_shop_id = it.shopee_shop_id and v.order_sn = it.order_sn
      where v.organization_id = p_organization_id
        and v.environment = 'live'
        and v.situacao = 'VALIDA'
      group by it.sku_id
    ) x
    group by x.sku_id
  ),
  -- ---- Ruptura nos últimos 30 dias ----
  dias as (
    select d::date as dia from generate_series(v_ate - 29, v_ate, interval '1 day') d
  ),
  saldo_local as (
    select b.sku_id, sum(b.quantity) as local
    from public.inventory_balances b
    where b.organization_id = p_organization_id
      and b.location_kind = 'LOCAL'
      and b.sku_id in (select a.sku_id from alvo a)
    group by b.sku_id
  ),
  movimentos as (
    select m.sku_id, (m.occurred_at at time zone 'America/Sao_Paulo')::date as dia, sum(m.qty_delta) as delta
    from public.stock_movements m
    where m.organization_id = p_organization_id
      and m.location_kind = 'LOCAL'
      and m.sku_id in (select a.sku_id from alvo a)
      and m.occurred_at >= ((v_ate - 29)::timestamp at time zone 'America/Sao_Paulo')
    group by 1, 2
  ),
  -- O Full de cada dia pela definição CANÔNICA (D-173/D-204), aplicada no fim
  -- do dia: a última captura de cada bucket (`ml_account_id`, `inventory_id`)
  -- até ali, com a janela de frescor de 3 days.
  full_dia as (
    select a.sku_id, d.dia, coalesce(sum(q.quantity), 0) > 0 as positivo
    from alvo a
    cross join dias d
    left join lateral (
      select distinct on (f.ml_account_id, f.inventory_id) f.quantity
      from public.fulfillment_stock_snapshots f
      where f.organization_id = p_organization_id
        and f.sku_id = a.sku_id
        and f.captured_at < ((d.dia + 1)::timestamp at time zone 'America/Sao_Paulo')
        and f.captured_at >= ((d.dia + 1)::timestamp at time zone 'America/Sao_Paulo') - interval '3 days'
      order by f.ml_account_id, f.inventory_id, f.captured_at desc
    ) q on true
    group by a.sku_id, d.dia
  ),
  com_captura as (
    select distinct f.sku_id
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
      and f.sku_id in (select a.sku_id from alvo a)
      and f.captured_at >= ((v_ate - 29)::timestamp at time zone 'America/Sao_Paulo') - interval '3 days'
  ),
  tem_fonte as (
    select a.sku_id,
      not a.stock_is_virtual
      and (exists (select 1 from saldo_local s where s.sku_id = a.sku_id)
           or exists (select 1 from com_captura c where c.sku_id = a.sku_id)) as conhecido
    from alvo a
  ),
  -- D-877: os movimentos depois do fim da janela (p_date_to no passado) também
  -- saem do saldo atual, como no filtro antigo `m.dia > d.dia`, sem teto.
  depois_do_fim as (
    select m.sku_id, sum(m.delta) as delta
    from movimentos m
    where m.dia > v_ate
    group by m.sku_id
  ),
  -- O LOCAL no fim de cada dia é o saldo atual menos tudo o que entrou e saiu
  -- DEPOIS daquele dia. D-877: a soma "depois do dia" sai de uma janela
  -- acumulada, do último dia para trás, e não de uma subconsulta por
  -- (SKU, dia) que relia os movimentos do SKU 30 vezes.
  local_fim_do_dia as (
    select a.sku_id, d.dia,
      coalesce(s.local, 0)
        - coalesce(dep.delta, 0)
        - coalesce(sum(coalesce(m.delta, 0)) over (
            partition by a.sku_id order by d.dia desc
            rows between unbounded preceding and 1 preceding), 0) as local_fim
    from alvo a
    cross join dias d
    left join saldo_local s on s.sku_id = a.sku_id
    left join movimentos m on m.sku_id = a.sku_id and m.dia = d.dia
    left join depois_do_fim dep on dep.sku_id = a.sku_id
  ),
  ruptura as (
    select l.sku_id, count(*) filter (
      where l.local_fim <= 0
        and not coalesce((
          select f.positivo from full_dia f
          where f.sku_id = l.sku_id and f.dia = l.dia), false)
    )::integer as dias
    from local_fim_do_dia l
    group by l.sku_id
  ),
  -- ---- Pedidos sobrepostos (rascunho/aprovado, fora do trânsito) ----
  abertos as (
    select i.sku_id, o.id, o.order_number, o.status, sum(i.quantity_ordered) as quantidade
    from public.purchase_order_items i
    join public.purchase_orders o on o.id = i.purchase_order_id
    where i.organization_id = p_organization_id
      and i.sku_id in (select a.sku_id from alvo a)
      and o.status in ('DRAFT', 'APPROVED')
      and (p_exclude_order_id is null or o.id <> p_exclude_order_id)
    group by i.sku_id, o.id, o.order_number, o.status
  ),
  ultima_compra as (
    select distinct on (i.sku_id)
      i.sku_id, i.unit_cost, o.currency, o.created_at, o.order_number, sp.name as fornecedor
    from public.purchase_order_items i
    join public.purchase_orders o on o.id = i.purchase_order_id
    left join public.suppliers sp on sp.id = o.supplier_id
    where i.organization_id = p_organization_id
      and i.sku_id in (select a.sku_id from alvo a)
      and o.status in ('ORDERED', 'RECEIVED')
      and (p_exclude_order_id is null or o.id <> p_exclude_order_id)
    order by i.sku_id, o.created_at desc
  ),
  regra as (
    select ss.* from public.supplier_skus ss
    where p_supplier_id is not null
      and ss.supplier_id = p_supplier_id
      and ss.sku_id in (select a.sku_id from alvo a)
  ),
  preferido as (
    select ss.sku_id, sp.id as supplier_id, sp.name
    from public.supplier_skus ss
    join public.suppliers sp on sp.id = ss.supplier_id
    where ss.is_preferred and ss.sku_id in (select a.sku_id from alvo a)
  )
  select jsonb_build_object(
    'data', v_ate,
    'new_product_days', coalesce((select r.new_product_days from public.purchase_review_settings r where r.organization_id = p_organization_id), 60),
    'margem_minima', coalesce((select t.margin_floor from public.central_thresholds t where t.organization_id = p_organization_id), 0.10),
    'linhas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sku_id', a.sku_id, 'sku', a.sku, 'title', a.title, 'supplier_brand', a.supplier_brand,
        'purchase_cost', a.purchase_cost, 'stock_is_virtual', a.stock_is_virtual,
        -- Fora do universo da reposição (sem saldo, venda nem anúncio): os
        -- ingredientes da sugestão vêm nulos e a tela diz "fora da reposição".
        'na_reposicao', case when coalesce(p_incluir_sugestao, true) then s.sku_id is not null end,
        'local_quantity', s.local_quantity, 'reservado', s.reservado, 'transito', s.transito,
        'full_quantity', s.full_quantity,
        'units_15d', s.units_15d, 'units_30d', s.units_30d, 'units_60d', s.units_60d, 'units_90d', s.units_90d,
        'history_days_90', s.history_days_90, 'abc_class', s.abc_class,
        'units_30d_shopee', s.units_30d_shopee, 'units_90d_shopee', s.units_90d_shopee,
        'is_discontinued', a.is_discontinued,
        'kind', a.kind,
        'days_since_created', (v_ate - (a.created_at at time zone 'America/Sao_Paulo')::date),
        'first_sale_date', pv.dia,
        'days_since_first_sale', case when pv.dia is null then null else v_ate - pv.dia end,
        'stockout_days_30', case when tf.conhecido then r.dias end,
        'other_open_quantity', coalesce((select sum(ab.quantidade) from abertos ab where ab.sku_id = a.sku_id), 0),
        'other_open_orders', coalesce((
          select jsonb_agg(jsonb_build_object('id', ab.id, 'order_number', ab.order_number,
                                              'status', ab.status, 'quantity', ab.quantidade)
                           order by ab.order_number)
          from abertos ab where ab.sku_id = a.sku_id), '[]'::jsonb),
        'last_purchase', (
          select jsonb_build_object('unit_cost', u.unit_cost, 'currency', u.currency, 'at', u.created_at,
                                    'order_number', u.order_number, 'supplier', u.fornecedor)
          from ultima_compra u where u.sku_id = a.sku_id),
        'supplier_rule', (
          select jsonb_build_object('supplier_code', g.supplier_code, 'unit_cost', g.unit_cost, 'currency', g.currency,
                                    'minimum_order_quantity', g.minimum_order_quantity, 'pack_multiple', g.pack_multiple,
                                    'lead_time_days', g.lead_time_days)
          from regra g where g.sku_id = a.sku_id),
        'preferred_supplier', (
          select jsonb_build_object('id', pf.supplier_id, 'name', pf.name)
          from preferido pf where pf.sku_id = a.sku_id)
      ) order by a.sku)
      from alvo a
      left join sugestao s on s.sku_id = a.sku_id
      left join primeira_venda pv on pv.sku_id = a.sku_id
      left join ruptura r on r.sku_id = a.sku_id
      left join tem_fonte tf on tf.sku_id = a.sku_id), '[]'::jsonb)
  )
  );
end;
$$;

comment on function public.get_purchase_analysis(uuid, uuid[], date, uuid, uuid, boolean) is
  'Ingredientes da avaliação de compra (D-721) para até 500 SKUs: as colunas de get_purchase_suggestions, idade comercial (1ª venda ML/Shopee e cadastro), dias dos últimos 30 com o vendável zerado (LOCAL do ledger no fim do dia e Full das capturas de 3 dias; nulo sem fonte), pedidos sobrepostos em rascunho/aprovado (fora p_exclude_order_id), a última compra e as regras do fornecedor p_supplier_id. p_incluir_sugestao falso: só os extras, na_reposicao nulo. Também o piso de margem (D-410) e os dias de produto recente. security invoker.';

revoke all on function public.get_purchase_analysis(uuid, uuid[], date, uuid, uuid, boolean) from public, anon;
grant execute on function public.get_purchase_analysis(uuid, uuid[], date, uuid, uuid, boolean) to authenticated, service_role;
