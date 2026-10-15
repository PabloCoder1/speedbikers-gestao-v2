-- ============================================================
-- D-459 -- C-65: a demanda da Shopee na cobertura e na sugestao de compra.
-- O dono confirmou (15/10) que a planilha do UpSeller ja desconta do estoque
-- a venda da Shopee; com a demanda so do ML, um SKU que tambem vende la
-- aparecia com cobertura alta demais e sugestao baixa demais. Decisao do dono:
-- "pode somar a demanda da Shopee agora" (substitui a de 14/10).
--
-- - A demanda da Shopee: unidades dos itens de vendas VALIDAS (5S) das lojas
--   LIVE, por SKU e dia de Sao Paulo (`shopee_sales_items`); a loja de teste
--   nunca entra. A mesma leitura nas tres funcoes que leem demanda.
-- - `get_stock_coverage` e `get_purchase_suggestions`: as vendas e as janelas
--   passam a ser ML + Shopee (cobertura, ruptura, venda/dia, recusas, estado
--   e sugestao), com colunas novas da parte da Shopee -- NULAS sem loja live
--   com pedidos lidos, 0 quando ha e o SKU nao vendeu. history_days_90 segue
--   sendo a cobertura de dados do ML.
-- - Quem le get_purchase_suggestions por POSICAO (overview e pedido de compra)
--   ganha os dois nomes; o pedido de compra leva units_30d_shopee nas linhas.
-- - `get_replenishment_reach`: a venda de 30 dias soma a Shopee.
-- - Sem loja live (hoje), todo numero identico ao das funcoes antigas.
-- ============================================================

drop function public.get_stock_coverage(uuid, date, date, uuid, text);
drop function public.get_purchase_suggestions(uuid, date, text, text, integer, integer, text);

CREATE FUNCTION public.get_stock_coverage(p_organization_id uuid, p_date_from date, p_date_to date, p_sku_id uuid DEFAULT NULL::uuid, p_supplier_brand text DEFAULT NULL::text)
 RETURNS TABLE(sku_id uuid, sku text, title text, local_quantity numeric, units_sold bigint, avg_daily_sales numeric, days_of_coverage numeric, is_ruptura boolean, stock_is_virtual boolean, units_15d bigint, units_30d bigint, units_60d bigint, units_90d bigint, history_days_90 bigint, units_sold_ml bigint, units_sold_shopee bigint, units_30d_shopee bigint, units_90d_shopee bigint)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
#variable_conflict use_column
begin
  return query
  with
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
  shopee as materialized (
    -- C-65 (D-459): a demanda da Shopee -- unidades dos itens de vendas
    -- VALIDAS (5S, a definicao mora em shopee_sales_orders) das lojas LIVE, por
    -- SKU e dia de Sao Paulo. A loja de teste nunca entra.
    select i.sku_id, i.dia, sum(i.quantity)::bigint as unidades
    from public.shopee_sales_items i
    where i.organization_id = p_organization_id
      and i.environment = 'live'
      and i.situacao = 'VALIDA'
      and i.sku_id is not null
      and (p_sku_id is null or i.sku_id = p_sku_id)
      and i.dia > least(p_date_from - 1, p_date_to - 90)
      and i.dia <= p_date_to
    group by i.sku_id, i.dia
  ),
  sales_ml as (
    select m.sku_id, sum(m.units_sold) as units_sold
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and (p_sku_id is null or m.sku_id = p_sku_id)
      and m.metric_date between p_date_from and p_date_to
    group by m.sku_id
  ),
  sales_shopee as (
    select sh.sku_id, sum(sh.unidades) as units
    from shopee sh
    where sh.dia between p_date_from and p_date_to
    group by sh.sku_id
  ),
  sales as (
    -- O total e o ML + a Shopee; um SKU so da Shopee tambem entra.
    select coalesce(m.sku_id, s.sku_id) as sku_id,
      coalesce(m.units_sold, 0) + coalesce(s.units, 0) as units_sold,
      m.units_sold as units_ml,
      s.units as units_shopee
    from sales_ml m
    full outer join sales_shopee s on s.sku_id = m.sku_id
  ),
  trend_ml as (
    select m.sku_id,
      coalesce(sum(m.units_sold) filter (where m.metric_date > p_date_to - 15), 0)::bigint as units_15d,
      coalesce(sum(m.units_sold) filter (where m.metric_date > p_date_to - 30), 0)::bigint as units_30d,
      coalesce(sum(m.units_sold) filter (where m.metric_date > p_date_to - 60), 0)::bigint as units_60d,
      coalesce(sum(m.units_sold), 0)::bigint as units_90d
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and (p_sku_id is null or m.sku_id = p_sku_id)
      and m.metric_date > p_date_to - 90
      and m.metric_date <= p_date_to
    group by m.sku_id
  ),
  trend_shopee as (
    select sh.sku_id,
      coalesce(sum(sh.unidades) filter (where sh.dia > p_date_to - 15), 0)::bigint as u15,
      coalesce(sum(sh.unidades) filter (where sh.dia > p_date_to - 30), 0)::bigint as u30,
      coalesce(sum(sh.unidades) filter (where sh.dia > p_date_to - 60), 0)::bigint as u60,
      coalesce(sum(sh.unidades) filter (where sh.dia > p_date_to - 90), 0)::bigint as u90
    from shopee sh
    group by sh.sku_id
  ),
  trend_windows as (
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
    -- SEM filtro de marca, de proposito: esta contagem e sobre o pipeline de
    -- metricas da ORGANIZACAO, e e o que sustenta a recusa
    -- HISTORICO_INCOMPLETO de D-145.
    select count(distinct m.metric_date)::bigint as history_days_90
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date > p_date_to - 90
      and m.metric_date <= p_date_to
  ),
  stock as (
    select b.sku_id, b.quantity as local_quantity
    from public.inventory_balances b
    where b.organization_id = p_organization_id
      and b.location_kind = 'LOCAL'
      and (p_sku_id is null or b.sku_id = p_sku_id)
  ),
  combined as (
    -- `sales.` e `stock.` QUALIFICADOS: sao os nomes que colidiriam com as
    -- variaveis homonimas de `returns table` num corpo plpgsql (D-305).
    select coalesce(sales.sku_id, stock.sku_id) as sku_id, sales.units_sold, sales.units_ml, sales.units_shopee, stock.local_quantity
    from sales
    full outer join stock on stock.sku_id = sales.sku_id
  )
  select
    sk.id,
    sk.sku,
    sk.title,
    coalesce(c.local_quantity, 0) as local_quantity,
    coalesce(c.units_sold, 0)::bigint as units_sold,
    round(coalesce(c.units_sold, 0)::numeric / nullif(p_date_to - p_date_from + 1, 0), 3) as avg_daily_sales,
    case
      when sk.stock_is_virtual then null
      when coalesce(c.units_sold, 0) = 0 then null
      else round(
        coalesce(c.local_quantity, 0)
        / (coalesce(c.units_sold, 0)::numeric / nullif(p_date_to - p_date_from + 1, 0)),
        1
      )
    end as days_of_coverage,
    (not sk.stock_is_virtual
       and coalesce(c.local_quantity, 0) <= 0
       and coalesce(c.units_sold, 0) > 0) as is_ruptura,
    sk.stock_is_virtual,
    coalesce(t.units_15d, 0),
    coalesce(t.units_30d, 0),
    coalesce(t.units_60d, 0),
    coalesce(t.units_90d, 0),
    h.history_days_90,
    coalesce(c.units_ml, 0)::bigint,
    case when (select sl.lida from shopee_lida sl) then coalesce(c.units_shopee, 0) end::bigint,
    case when (select sl.lida from shopee_lida sl) then coalesce(t.shopee_30d, 0) end::bigint,
    case when (select sl.lida from shopee_lida sl) then coalesce(t.shopee_90d, 0) end::bigint
  from combined c
  join public.skus sk on sk.id = c.sku_id
  left join trend_windows t on t.sku_id = c.sku_id
  cross join history h
  -- Forma da casa: `sk` ja estava juntado, entao o filtro cai aqui e nao
  -- precisa de join novo (diferente de `get_sku_abc_curve`, D-235).
  where (p_supplier_brand is null or sk.supplier_brand = p_supplier_brand);
end;
$function$;

CREATE FUNCTION public.get_purchase_suggestions(p_organization_id uuid, p_date_to date, p_supplier_brand text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_state text DEFAULT NULL::text)
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
  shopee as materialized (
    -- C-65 (D-459): a demanda da Shopee -- unidades dos itens de vendas
    -- VALIDAS (5S, a definicao mora em shopee_sales_orders) das lojas LIVE, por
    -- SKU e dia de Sao Paulo. A loja de teste nunca entra.
    select i.sku_id, i.dia, sum(i.quantity)::bigint as unidades
    from public.shopee_sales_items i
    where i.organization_id = p_organization_id
      and i.environment = 'live'
      and i.situacao = 'VALIDA'
      and i.sku_id is not null
      and i.dia > (select ate from janela) - 90
      and i.dia <= (select ate from janela)
    group by i.sku_id, i.dia
  ),
  pivot as (
    select b.sku_id,
      sum(b.quantity) filter (where b.location_kind = 'LOCAL')     as local_quantity,
      sum(b.quantity) filter (where b.location_kind = 'RESERVADO') as reservado,
      sum(b.quantity) filter (where b.location_kind = 'TRANSITO')  as transito
    from public.inventory_balances b
    where b.organization_id = p_organization_id
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
      order by f.ml_account_id, f.inventory_id, f.captured_at desc
    ) q
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
    select c.sku_id, sk.sku, sk.title, sk.supplier_brand, sk.purchase_cost,
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
    from combined c
    join public.skus sk on sk.id = c.sku_id
    left join full_por_sku fp on fp.sku_id = c.sku_id
    left join abc ab on ab.sku_id = c.sku_id
    left join settings s_sku   on s_sku.sku_id = c.sku_id
    left join settings s_brand on s_brand.supplier_brand = sk.supplier_brand and s_brand.sku_id is null
    left join settings s_org   on s_org.supplier_brand is null and s_org.sku_id is null
    where (p_supplier_brand is null or sk.supplier_brand = p_supplier_brand)
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

CREATE OR REPLACE FUNCTION public.get_replenishment_overview(p_organization_id uuid, p_date_to date, p_supplier_brand text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_state text DEFAULT NULL::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  resultado jsonb;
begin
  with todas as (
    -- UMA classificacao do catalogo, sem filtro de estado: os cartoes precisam
    -- dos outros estados quando um deles esta ativo (D-250).
    select o.*
    from public.get_purchase_suggestions(
           p_organization_id, p_date_to, p_supplier_brand, p_search, 1000000, 0, null
         ) with ordinality as o(
           sku_id, sku, title, supplier_brand, purchase_cost, stock_is_virtual,
           local_quantity, reservado, transito, full_quantity,
           units_15d, units_30d, units_60d, units_90d, history_days_90,
           abc_class, coverage_days, state, suggested_quantity, total_count,
           units_30d_shopee, units_90d_shopee, ordem
         )
  ),
  filtrada as (
    select t.*
    from todas t
    where p_state is null
       or (p_state = 'SEM_ESTADO' and t.state is null)
       or t.state = p_state
  ),
  contagens as (
    select
      coalesce(t.state, 'SEM_ESTADO') as state,
      count(*)::bigint as skus,
      coalesce(sum(t.suggested_quantity) filter (where t.suggested_quantity > 0), 0)::bigint as unidades,
      round(coalesce(sum(t.suggested_quantity * t.purchase_cost)
        filter (where t.suggested_quantity > 0 and t.purchase_cost > 0), 0), 2) as investimento,
      count(*) filter (where t.suggested_quantity > 0
                         and (t.purchase_cost is null or t.purchase_cost <= 0))::bigint as sem_custo
    from todas t
    group by 1
  ),
  pagina as (
    select f.*
    from filtrada f
    order by f.ordem
    limit greatest(p_limit, 0) offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrada),
    'contagens', coalesce((
      select jsonb_agg(jsonb_build_object(
               'state', c.state, 'skus', c.skus, 'unidades', c.unidades,
               'investimento', c.investimento, 'sem_custo', c.sem_custo))
      from contagens c), '[]'::jsonb),
    -- Os agregados que a tela mostra sem somar nada: o total de todos os
    -- estados e o "comprar agora" (ruptura + compra urgente), no MESMO
    -- conjunto dos cartoes.
    'totais', (
      select jsonb_build_object(
        'skus', count(*),
        'unidades', coalesce(sum(t.suggested_quantity) filter (where t.suggested_quantity > 0), 0),
        'investimento', round(coalesce(sum(t.suggested_quantity * t.purchase_cost)
          filter (where t.suggested_quantity > 0 and t.purchase_cost > 0), 0), 2),
        'sem_custo', count(*) filter (where t.suggested_quantity > 0
                                       and (t.purchase_cost is null or t.purchase_cost <= 0)))
      from todas t),
    'comprar_agora', (
      select jsonb_build_object(
        'skus', count(*),
        'unidades', coalesce(sum(t.suggested_quantity) filter (where t.suggested_quantity > 0), 0),
        'investimento', round(coalesce(sum(t.suggested_quantity * t.purchase_cost)
          filter (where t.suggested_quantity > 0 and t.purchase_cost > 0), 0), 2),
        'sem_custo', count(*) filter (where t.suggested_quantity > 0
                                       and (t.purchase_cost is null or t.purchase_cost <= 0)))
      from todas t
      where t.state in ('RUPTURA', 'COMPRA_URGENTE')),
    'linhas', coalesce((
      select jsonb_agg((to_jsonb(p) - 'ordem' - 'total_count') order by p.ordem)
      from pagina p), '[]'::jsonb),
    -- O frescor das duas entradas que envelhecem sozinhas. NULL = nunca houve.
    'vendas_calculadas_em', (
      select max(m.computed_at) from public.daily_sku_metrics m
      where m.organization_id = p_organization_id
        and m.metric_date > coalesce(p_date_to, current_date) - 90),
    -- O frescor do Full sai da MESMA leitura canonica que o Full conta (D-173,
    -- D-204): a captura mais recente de cada (conta, inventory_id) na janela
    -- de 3 dias. Um `max(captured_at)` direto na tabela devolve o mesmo
    -- numero -- o maximo dos maximos por bucket e' o maximo da janela --, mas
    -- seria uma sexta forma de ler `fulfillment_stock_snapshots`, e e'
    -- exatamente isso que o teste de D-204 recusa. Lido assim, o horario
    -- mostrado e' o do Full que a tela de fato soma.
    'full_capturado_em', (
      select max(q.captured_at)
      from (
        select distinct on (f.ml_account_id, f.inventory_id) f.captured_at
        from public.fulfillment_stock_snapshots f
        where f.organization_id = p_organization_id
          and f.captured_at >= now() - interval '3 days'
        order by f.ml_account_id, f.inventory_id, f.captured_at desc
      ) q)
  )
  into resultado;

  return resultado;
end
$function$;

CREATE OR REPLACE FUNCTION public.get_purchase_order_suggestions(p_organization_id uuid, p_sku_ids uuid[] DEFAULT NULL::uuid[], p_supplier_brand text DEFAULT NULL::text, p_scope text DEFAULT NULL::text, p_limit integer DEFAULT 500, p_date_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  marca text := nullif(btrim(coalesce(p_supplier_brand, '')), '');
  resultado jsonb;
begin
  if (p_sku_ids is null or cardinality(p_sku_ids) = 0) and marca is null then
    return jsonb_build_object('total', 0, 'linhas', '[]'::jsonb);
  end if;

  with sugestao as (
    select o.*
    from public.get_purchase_suggestions(
           p_organization_id, p_date_to, marca, null, 1000000, 0, null
         ) with ordinality as o(
           sku_id, sku, title, supplier_brand, purchase_cost, stock_is_virtual,
           local_quantity, reservado, transito, full_quantity,
           units_15d, units_30d, units_60d, units_90d, history_days_90,
           abc_class, coverage_days, state, suggested_quantity, total_count,
           units_30d_shopee, units_90d_shopee, ordem
         )
  ),
  recorte as (
    select s.*
    from sugestao s
    where (p_sku_ids is null or cardinality(p_sku_ids) = 0 or s.sku_id = any (p_sku_ids))
      and (marca is null
           or p_scope is null
           or (p_scope = 'comprar_agora' and s.state in ('RUPTURA', 'COMPRA_URGENTE') and s.suggested_quantity > 0)
           or (p_scope = 'com_sugestao' and s.suggested_quantity > 0))
  ),
  pagina as (
    select r.*
    from recorte r
    order by r.ordem
    limit greatest(least(coalesce(p_limit, 500), 500), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from recorte),
    'linhas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sku_id', p.sku_id,
               'sku', p.sku,
               'title', p.title,
               'supplier_brand', p.supplier_brand,
               'purchase_cost', p.purchase_cost,
               'is_imported', k.is_imported,
               'state', p.state,
               'suggested_quantity', p.suggested_quantity,
               'coverage_days', p.coverage_days,
               'units_30d', p.units_30d,
               'units_30d_shopee', p.units_30d_shopee,
               'aproveitavel', case when p.stock_is_virtual then null
                                    else p.local_quantity + p.full_quantity + p.transito - p.reservado end)
             order by p.ordem)
      from pagina p
      left join public.skus k on k.id = p.sku_id), '[]'::jsonb)
  )
  into resultado;

  return resultado;
end
$function$;

CREATE OR REPLACE FUNCTION public.get_replenishment_reach(p_organization_id uuid, p_date_to date DEFAULT NULL::date)
 RETURNS TABLE(supplier_brand text, skus bigint, skus_na_reposicao bigint, skus_com_venda_30d bigint, skus_com_regra_sku bigint, skus_com_regra_sku_venda_30d bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with janela as (
    select coalesce(p_date_to, current_date) as ate
  ),
  com_saldo as (
    select distinct b.sku_id
    from public.inventory_balances b
    where b.organization_id = p_organization_id
  ),
  vendas as (
    -- As mesmas bordas de `trend_windows` em `get_purchase_suggestions`.
    select m.sku_id,
      coalesce(sum(m.units_sold) filter (where m.metric_date > (select ate from janela) - 30), 0) as units_30d
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and m.metric_date > (select ate from janela) - 90
      and m.metric_date <= (select ate from janela)
    group by m.sku_id
  ),
  vendas_shopee as (
    -- C-65 (D-459): a mesma demanda da Shopee de get_purchase_suggestions.
    select i.sku_id,
      coalesce(sum(i.quantity) filter (where i.dia > (select ate from janela) - 30), 0) as units_30d
    from public.shopee_sales_items i
    where i.organization_id = p_organization_id
      and i.environment = 'live'
      and i.situacao = 'VALIDA'
      and i.sku_id is not null
      and i.dia > (select ate from janela) - 90
      and i.dia <= (select ate from janela)
    group by i.sku_id
  ),
  vendas_total as (
    select coalesce(v.sku_id, vs.sku_id) as sku_id, coalesce(v.units_30d, 0) + coalesce(vs.units_30d, 0) as units_30d
    from vendas v
    full outer join vendas_shopee vs on vs.sku_id = v.sku_id
  ),
  universo as (
    select coalesce(s.sku_id, v.sku_id) as sku_id, coalesce(v.units_30d, 0) as units_30d
    from com_saldo s
    full outer join vendas_total v on v.sku_id = s.sku_id
  ),
  regra_sku as (
    select r.sku_id
    from public.replenishment_settings r
    where r.organization_id = p_organization_id
      and r.sku_id is not null
  )
  select
    sk.supplier_brand,
    count(*)::bigint as skus,
    count(u.sku_id)::bigint as skus_na_reposicao,
    count(u.sku_id) filter (where u.units_30d > 0)::bigint as skus_com_venda_30d,
    count(rs.sku_id) filter (where u.sku_id is not null)::bigint as skus_com_regra_sku,
    count(rs.sku_id) filter (where u.units_30d > 0)::bigint as skus_com_regra_sku_venda_30d
  from public.skus sk
  left join universo u on u.sku_id = sk.id
  left join regra_sku rs on rs.sku_id = sk.id
  where sk.organization_id = p_organization_id
  group by sk.supplier_brand
  order by sk.supplier_brand nulls first;
$function$;

comment on function public.get_stock_coverage(uuid, date, date, uuid, text) is
  'Cobertura de estoque por SKU no periodo: vendas e janelas de 15/30/60/90 dias = ML (daily_sku_metrics) + Shopee (vendas validas das lojas live, C-65/D-459); units_sold_ml e as colunas _shopee mostram a divisao (Shopee NULA sem loja live com pedidos lidos). history_days_90 = cobertura de dados do ML. security invoker.';
revoke all on function public.get_stock_coverage(uuid, date, date, uuid, text) from public, anon;
grant execute on function public.get_stock_coverage(uuid, date, date, uuid, text) to authenticated, service_role;

comment on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer, text) is
  'Sugestao de compra (D-147/D-150): janelas de venda = ML + Shopee (vendas validas das lojas live, C-65/D-459), venda/dia de 30 dias, recusas, estado e sugestao sobre o total; units_30d_shopee/units_90d_shopee mostram a parte da Shopee (NULA sem loja live com pedidos lidos). security invoker.';
revoke all on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer, text) from public, anon;
grant execute on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer, text) to authenticated, service_role;
