-- Sugestao de compra auditavel (D-147, Fase 5D) -- a RPC entrega os
-- INGREDIENTES, nunca a formula. A conta (taxa x janela - aproveitavel, com
-- as recusas se propagando) mora em @sb/domain/purchasing
-- (computePurchaseSuggestion) -- regra da formula unica: enquanto a ordenacao
-- da tela nao precisar do numero em SQL (priorizacao e item proprio da fase),
-- nao existe versao SQL para divergir.
--
-- O que cada bloco reusa, de proposito:
--   * pivot LOCAL/RESERVADO/TRANSITO e o Full do ultimo snapshot por conta:
--     mesmos blocos de get_stock_balances (D-139), incluindo a licao do
--     captured_at por RODADA (ler so o max por conta troca 64.416 linhas
--     historicas por ~2.165);
--   * janelas 15/30/60/90 TRAILING e history_days_90: mesmos blocos de
--     get_stock_coverage (D-145) -- history_days_90 e a guarda que faz a
--     sugestao SE RECUSAR se o buraco de recalculo voltar.
--
-- Universo: full outer join entre saldo e venda de 90d -- SKU que vende sem
-- saldo registrado entra (e o caso que MAIS precisa de sugestao), SKU parado
-- com saldo tambem (a recusa por amostra e a resposta certa para ele).
--
-- Ordenacao: units_30d desc (demanda recente primeiro), sku como desempate
-- deterministico. Ordenar pela SUGESTAO exigiria a formula em SQL com teste
-- de equivalencia -- e priorizacao de compras e item aberto da fase.
--
-- EXPLAIN (ANALYZE, BUFFERS) 2026-08-30: 90 ms quente, 5.445 buffers,
-- 3.276 linhas na organizacao inteira. Nenhum indice novo. (Primeira
-- execucao fria: 1.652 ms dominados por read=1.139 do storage.)

create function public.get_purchase_suggestions(
  p_organization_id uuid,
  p_date_to date,
  p_supplier_brand text default null,
  p_search text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  sku_id uuid,
  sku text,
  title text,
  supplier_brand text,
  purchase_cost numeric,
  stock_is_virtual boolean,
  local_quantity numeric,
  reservado numeric,
  transito numeric,
  full_quantity numeric,
  units_15d bigint,
  units_30d bigint,
  units_60d bigint,
  units_90d bigint,
  history_days_90 bigint,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with pivot as (
    select b.sku_id,
      sum(b.quantity) filter (where b.location_kind = 'LOCAL')     as local_quantity,
      sum(b.quantity) filter (where b.location_kind = 'RESERVADO') as reservado,
      sum(b.quantity) filter (where b.location_kind = 'TRANSITO')  as transito
    from public.inventory_balances b
    where b.organization_id = p_organization_id
    group by b.sku_id
  ),
  ultima_captura as (
    -- `captured_at` e carimbo por RODADA do job, nao por item (D-139).
    select f.ml_account_id, max(f.captured_at) as captured_at
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
    group by f.ml_account_id
  ),
  full_por_sku as (
    select f.sku_id, sum(f.quantity) as full_quantity
    from public.fulfillment_stock_snapshots f
    join ultima_captura u
      on u.ml_account_id = f.ml_account_id and u.captured_at = f.captured_at
    where f.organization_id = p_organization_id
    group by f.sku_id
  ),
  trend_windows as (
    select m.sku_id,
      coalesce(sum(m.units_sold) filter (where m.metric_date > p_date_to - 15), 0)::bigint as units_15d,
      coalesce(sum(m.units_sold) filter (where m.metric_date > p_date_to - 30), 0)::bigint as units_30d,
      coalesce(sum(m.units_sold) filter (where m.metric_date > p_date_to - 60), 0)::bigint as units_60d,
      coalesce(sum(m.units_sold), 0)::bigint as units_90d
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and m.metric_date > p_date_to - 90
      and m.metric_date <= p_date_to
    group by m.sku_id
  ),
  history as (
    select count(distinct m.metric_date)::bigint as history_days_90
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date > p_date_to - 90
      and m.metric_date <= p_date_to
  ),
  combined as (
    select coalesce(p.sku_id, t.sku_id) as sku_id,
      p.local_quantity, p.reservado, p.transito,
      t.units_15d, t.units_30d, t.units_60d, t.units_90d
    from pivot p
    full outer join trend_windows t on t.sku_id = p.sku_id
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
      coalesce(c.units_90d, 0) as units_90d
    from combined c
    join public.skus sk on sk.id = c.sku_id
    left join full_por_sku fp on fp.sku_id = c.sku_id
    where (p_supplier_brand is null or sk.supplier_brand = p_supplier_brand)
      and (p_search is null
           or sk.sku   ilike '%' || p_search || '%'
           or sk.title ilike '%' || p_search || '%')
  )
  select b.*, h.history_days_90, count(*) over () as total_count
  from base b
  cross join history h
  order by b.units_30d desc, b.sku
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;

comment on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer) is
  'Ingredientes da sugestao de compra auditavel (D-147): saldo pivotado LOCAL/RESERVADO/TRANSITO, Full do ultimo snapshot por conta, janelas de venda 15/30/60/90d TRAILING encerradas em p_date_to, history_days_90 (guarda contra historico furado, D-145), marca, custo cadastrado e stock_is_virtual, com filtros, janela e contagem total. A FORMULA (taxa x janela de demanda - aproveitavel, com recusas) mora em @sb/domain/purchasing (computePurchaseSuggestion) -- regra da formula unica; esta RPC nunca calcula sugestao.';

revoke all on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer) from public, anon;
grant execute on function public.get_purchase_suggestions(uuid, date, text, text, integer, integer) to authenticated, service_role;
