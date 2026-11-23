-- D-795: o produto que sai da planilha de produtos do UpSeller fica marcado
-- como FORA DO CATÁLOGO, nunca apagado.
--
-- Até aqui a aplicação de um lote PRODUCTS só criava e atualizava os SKUs que
-- estavam no arquivo. O que sumiu da exportação ficava ativo, com o último
-- saldo, e continuava na Reposição como se ainda existisse. Apagar não serve:
-- o SKU é referenciado por pedidos, vínculos, pedidos de compra e pelo ledger
-- de estoque.
--
-- A regra:
-- * só é julgado o SKU PRODUTO que já veio numa planilha de produtos APLICADA
--   antes (o criado pela invoice, D-792, ou o kit do arquivo de kits, nunca);
-- * "presente" é qualquer linha OK da planilha nova com aquele sku_key. A
--   linha de produto só deixa de ser OK quando não tem SKU (mapProductRow), e
--   essa não diz de qual produto se trata;
-- * a marcação só acontece quando quem confirma a aplicação diz que o arquivo
--   é o catálogo completo (a tela sugere desmarcar acima de 10%);
-- * marcado = `is_active` falso + `erp_absent_since`/`erp_absent_batch_id`.
--   O falso no `is_active` leva o produto para "Inativo" em todas as telas que
--   já tratam a situação; a coluna nova diz POR QUE ele está inativo;
-- * o produto que volta numa planilha posterior perde a marca, e o `is_active`
--   volta a ser o que o UpSeller manda (a própria aplicação grava);
-- * o saldo NÃO vira zero (ausência de dado não é zero): a Reposição deixa o
--   SKU marcado de fora, e as outras telas mostram o último saldo como está.

alter table public.skus
  add column erp_absent_since timestamptz,
  add column erp_absent_batch_id uuid references public.erp_import_batches(id) on delete set null;

-- Lote apagado zera a referência e mantém a data: a marca continua valendo.
alter table public.skus
  add constraint skus_erp_absent_coherent
  check (erp_absent_batch_id is null or erp_absent_since is not null);

comment on column public.skus.erp_absent_since is
  'D-795: quando o SKU saiu da planilha de produtos do UpSeller (nulo = veio na última planilha aplicada com a marcação, ou nunca foi julgado). Junto com is_active falso.';
comment on column public.skus.erp_absent_batch_id is
  'D-795: o lote PRODUCTS que não trouxe o SKU e o marcou como fora do catálogo.';

create index skus_erp_absent_idx
  on public.skus (organization_id)
  where erp_absent_since is not null;

alter table public.erp_import_batches
  add column absent_marked integer check (absent_marked is null or absent_marked >= 0),
  add column absent_cleared integer check (absent_cleared is null or absent_cleared >= 0);

comment on column public.erp_import_batches.absent_marked is
  'D-795: quantos SKUs este lote PRODUCTS marcou como fora do catálogo. Nulo = a marcação não foi pedida (ou o lote não é de produtos).';
comment on column public.erp_import_batches.absent_cleared is
  'D-795: quantos SKUs marcados antes voltaram nesta planilha e perderam a marca.';


-- ---------------------------------------------------------------------------
-- 1. O conjunto: os SKUs que o lote deixaria de fora
-- ---------------------------------------------------------------------------
-- Uma só definição para a prévia (tela) e para a marcação (worker): os dois
-- números não podem discordar. security invoker: na tela a RLS limita à
-- organização de quem lê; no worker o service_role vê tudo.

create or replace function public.products_batch_absent_sku_ids(p_batch_id uuid)
returns setof uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select sk.id
  from public.erp_import_batches b
  join public.skus sk
    on sk.organization_id = b.organization_id
   and sk.kind = 'PRODUTO'
  where b.id = p_batch_id
    and b.kind = 'PRODUCTS'
    and not exists (
      select 1
      from public.erp_import_rows r
      where r.batch_id = b.id
        and r.status = 'OK'
        and r.sku_key = sk.sku_key
    )
    and exists (
      select 1
      from public.erp_import_batches pb
      join public.erp_import_rows pr on pr.batch_id = pb.id
      where pb.organization_id = b.organization_id
        and pb.kind = 'PRODUCTS'
        and pb.status = 'APPLIED'
        and pb.id <> b.id
        and pr.sku_key = sk.sku_key
        and pr.apply_status = 'APPLIED'
    );
$$;

comment on function public.products_batch_absent_sku_ids(uuid) is
  'D-795: SKUs PRODUTO que já vieram numa planilha de produtos aplicada e NÃO estão (linha OK) no lote p_batch_id. Vazio para lote que não é PRODUCTS. security invoker.';

revoke all on function public.products_batch_absent_sku_ids(uuid) from public, anon;
grant execute on function public.products_batch_absent_sku_ids(uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. A prévia da conferência
-- ---------------------------------------------------------------------------

create or replace function public.get_products_batch_absences(p_batch_id uuid, p_sample integer default 50)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with lote as (
    select b.id, b.organization_id
    from public.erp_import_batches b
    where b.id = p_batch_id
      and b.kind = 'PRODUCTS'
  ),
  conhecidos as (
    -- O denominador da tela: o catálogo que as planilhas de produtos já trouxeram.
    select sk.id
    from lote l
    join public.skus sk
      on sk.organization_id = l.organization_id
     and sk.kind = 'PRODUTO'
    where exists (
      select 1
      from public.erp_import_batches pb
      join public.erp_import_rows pr on pr.batch_id = pb.id
      where pb.organization_id = l.organization_id
        and pb.kind = 'PRODUCTS'
        and pb.status = 'APPLIED'
        and pb.id <> l.id
        and pr.sku_key = sk.sku_key
        and pr.apply_status = 'APPLIED'
    )
  ),
  ausentes as (
    select sk.id, sk.sku, sk.title, sk.erp_absent_since
    from public.products_batch_absent_sku_ids(p_batch_id) a(sku_id)
    join public.skus sk on sk.id = a.sku_id
  ),
  saldo as (
    select b.sku_id, sum(b.quantity) as quantidade
    from public.inventory_balances b
    join ausentes a on a.id = b.sku_id
    where b.location_kind = 'LOCAL'
    group by b.sku_id
  ),
  vinculo as (
    select distinct k.sku_id
    from public.sku_listing_links k
    join ausentes a on a.id = k.sku_id
  ),
  voltam as (
    select sk.id
    from lote l
    join public.skus sk
      on sk.organization_id = l.organization_id
     and sk.erp_absent_since is not null
    where exists (
      select 1
      from public.erp_import_rows r
      where r.batch_id = l.id
        and r.status = 'OK'
        and r.sku_key = sk.sku_key
    )
  ),
  amostra as (
    select a.id, a.sku, a.title, a.erp_absent_since
    from ausentes a
    order by a.sku
    limit greatest(coalesce(p_sample, 50), 0)
  )
  select case
    when not exists (select 1 from lote) then null
    else jsonb_build_object(
      'conhecidos', (select count(*) from conhecidos),
      'ausentes', (select count(*) from ausentes),
      'jaMarcados', (select count(*) from ausentes where erp_absent_since is not null),
      'comSaldo', (select count(*) from saldo where quantidade > 0),
      'comVinculo', (select count(*) from vinculo),
      'voltam', (select count(*) from voltam),
      'amostra', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'skuId', m.id,
                 'sku', m.sku,
                 'title', m.title,
                 'saldo', s.quantidade,
                 'comVinculo', v.sku_id is not null,
                 'foraDesde', m.erp_absent_since)
               order by m.sku)
        from amostra m
        left join saldo s on s.sku_id = m.id
        left join vinculo v on v.sku_id = m.id
      ), '[]'::jsonb)
    )
  end;
$$;

comment on function public.get_products_batch_absences(uuid, integer) is
  'D-795: a prévia da conferência de um lote PRODUCTS: quantos SKUs conhecidos (já vieram numa planilha de produtos aplicada), quantos ficariam fora do catálogo, quantos destes já estavam marcados, têm saldo LOCAL positivo ou vínculo com anúncio, quantos marcados voltam, e uma amostra ordenada por SKU. Nulo para lote que não é PRODUCTS ou que a RLS esconde. security invoker.';

revoke all on function public.get_products_batch_absences(uuid, integer) from public, anon;
grant execute on function public.get_products_batch_absences(uuid, integer) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. A marcação, no fim da aplicação (worker)
-- ---------------------------------------------------------------------------
-- Idempotente: marcar só o que ainda não tem marca e acumular as contagens. A
-- reentrega do job depois de uma falha no meio soma zero.

create or replace function public.apply_products_batch_absences(p_batch_id uuid, p_mark boolean)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org uuid;
  v_kind text;
  v_marked integer := 0;
  v_cleared integer := 0;
begin
  select b.organization_id, b.kind
    into v_org, v_kind
  from public.erp_import_batches b
  where b.id = p_batch_id;

  if v_org is null then
    raise exception 'lote % não existe', p_batch_id;
  end if;

  if v_kind <> 'PRODUCTS' then
    raise exception 'lote % não é de produtos (%)', p_batch_id, v_kind;
  end if;

  -- Quem voltou perde a marca. O is_active já foi gravado pela aplicação,
  -- com o valor que o UpSeller manda: aqui só sai o motivo.
  update public.skus sk
     set erp_absent_since = null,
         erp_absent_batch_id = null
   where sk.organization_id = v_org
     and sk.erp_absent_since is not null
     and exists (
       select 1
       from public.erp_import_rows r
       where r.batch_id = p_batch_id
         and r.status = 'OK'
         and r.sku_key = sk.sku_key
     );

  get diagnostics v_cleared = row_count;

  if coalesce(p_mark, false) then
    update public.skus sk
       set erp_absent_since = now(),
           erp_absent_batch_id = p_batch_id,
           is_active = false
     where sk.id in (select a from public.products_batch_absent_sku_ids(p_batch_id) a)
       and sk.erp_absent_since is null;

    get diagnostics v_marked = row_count;
  end if;

  update public.erp_import_batches b
     set absent_marked = case
           when coalesce(p_mark, false) then coalesce(b.absent_marked, 0) + v_marked
           else b.absent_marked
         end,
         absent_cleared = coalesce(b.absent_cleared, 0) + v_cleared
   where b.id = p_batch_id;

  return jsonb_build_object('marked', v_marked, 'cleared', v_cleared);
end;
$$;

comment on function public.apply_products_batch_absences(uuid, boolean) is
  'D-795: no fim da aplicação de um lote PRODUCTS, tira a marca de fora do catálogo de quem voltou e, com p_mark, marca (is_active falso + erp_absent_since) os SKUs de products_batch_absent_sku_ids. Idempotente; acumula absent_marked/absent_cleared no lote. Só service_role.';

revoke all on function public.apply_products_batch_absences(uuid, boolean) from public, anon, authenticated;
grant execute on function public.apply_products_batch_absences(uuid, boolean) to service_role;


-- ---------------------------------------------------------------------------
-- 4. A Reposição deixa de fora o SKU marcado
-- ---------------------------------------------------------------------------
-- Republicação da definição de 20261116164846 (D-693) com uma linha a mais no
-- universo: `and sk.erp_absent_since is null`. get_replenishment_overview,
-- get_purchase_analysis e as sugestões do pedido de compra leem esta função e
-- herdam o recorte. CREATE OR REPLACE preserva assinatura e permissões.

CREATE OR REPLACE FUNCTION public.get_purchase_suggestions(p_organization_id uuid, p_date_to date, p_supplier_brand text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_state text DEFAULT NULL::text)
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
      -- D-795: o SKU fora do catálogo do UpSeller não entra na Reposição.
      and sk.erp_absent_since is null
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
