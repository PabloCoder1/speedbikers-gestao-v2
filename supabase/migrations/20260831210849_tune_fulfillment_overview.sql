-- ============================================================
-- Ajuste medido da Central Full (D-173) — a mesma classe de armadilha de
-- D-167, com o veredito INVERTIDO, e o motivo e o tamanho do conjunto.
--
-- A primeira versao usava `(select count(*) from filtrado)` como subconsulta
-- escalar, o desenho que D-167 aprovou para o ledger. Aqui ele custou
-- **899 ms**: o planner reexecutou a CTE do espelho para responder a
-- contagem, varrendo as capturas duas vezes.
--
-- Duas mudancas, ambas medidas:
--   1. `ultimo_bucket` vira `as materialized` — calculado UMA vez e reusado.
--   2. a contagem volta a ser `count(*) over ()`.
--
-- **Por que o oposto de D-167?** La o conjunto eram 225 mil movimentos, e a
-- window materializava tudo (685 ms, derramando em temp). Aqui o conjunto
-- final tem 1.872 linhas (pares conta+SKU): a window custa quase nada, e o
-- caro e reexecutar o espelho. Mesma armadilha, tamanhos diferentes — por
-- isso a regra da casa e MEDIR, nao copiar o desenho anterior.
--
-- Resultado: **899 ms -> 53 ms** sem filtro (33.563 buffers, sem temp) e
-- **97 ms** com filtro de situacao.
-- ============================================================

create or replace function public.get_fulfillment_overview(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_situation text default null,
  p_search text default null,
  p_sku_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  ml_account_id uuid,
  account_label text,
  sku_id uuid,
  sku text,
  sku_title text,
  full_quantity numeric,
  buckets integer,
  captured_at timestamptz,
  local_quantity numeric,
  units_sold bigint,
  situation text,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with ultimo_bucket as materialized (
    -- O GRAO: um saldo por bucket do Mercado Livre. Colapsar por SKU aqui
    -- perderia as variacoes (246 pares tem mais de uma).
    --
    -- `as materialized` nao e enfeite: sem ele o planner reexecuta esta
    -- varredura para a contagem, e a funcao passa de 53 ms para 899 ms.
    --
    -- Ler por BUCKET tambem torna esta RPC imune a rodada pela metade: o
    -- job carimba `captured_at` uma vez no inicio e leva 5 a 6,5 minutos
    -- gravando as ~500 linhas (MEDIDO em 31/08: 312 a 395 s por rodada).
    -- Quem le `where captured_at = max(captured_at)` ve, nesses minutos,
    -- so a fracao ja gravada; aqui um bucket ainda nao regravado
    -- simplesmente mantem a captura anterior.
    select distinct on (f.ml_account_id, f.inventory_id)
           f.ml_account_id, f.sku_id, f.quantity, f.captured_at
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
      and f.captured_at >= now() - interval '3 days'
      and (p_ml_account_id is null or f.ml_account_id = p_ml_account_id)
      and (p_sku_id is null or f.sku_id = p_sku_id)
    order by f.ml_account_id, f.inventory_id, f.captured_at desc
  ),
  full_por_sku as (
    select b.ml_account_id, b.sku_id,
           sum(b.quantity) as full_quantity,
           count(*)::integer as buckets,
           max(b.captured_at) as captured_at
    from ultimo_bucket b
    group by b.ml_account_id, b.sku_id
  ),
  vendas as (
    select m.ml_account_id, m.sku_id, sum(m.units_sold)::bigint as units_sold
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date between p_date_from and p_date_to
      and m.sku_id is not null
    group by m.ml_account_id, m.sku_id
  ),
  saldo_local as (
    -- Estoque fisico e da ORGANIZACAO, nao da conta (regra do PRD). Vem
    -- junto para responder "da para repor?", e a tela mostra em coluna
    -- separada: somar com o Full seria a "soma cega" que o item veta.
    select b.sku_id, sum(b.quantity) as local_quantity
    from public.inventory_balances b
    where b.organization_id = p_organization_id and b.location_kind = 'LOCAL'
    group by b.sku_id
  ),
  base as (
    select f.ml_account_id, a.label as account_label, f.sku_id, s.sku, s.title as sku_title,
           f.full_quantity, f.buckets, f.captured_at,
           coalesce(l.local_quantity, 0) as local_quantity,
           coalesce(v.units_sold, 0)::bigint as units_sold,
           -- Criterios DETERMINISTICOS e visiveis, sem score inventado.
           case
             when f.full_quantity > 0 and coalesce(v.units_sold, 0) > 0 then 'saudavel'
             when f.full_quantity > 0 then 'parado'
             when coalesce(v.units_sold, 0) > 0 then 'ruptura'
             else 'ausente'
           end as situation
    from full_por_sku f
    join public.ml_accounts a on a.id = f.ml_account_id
    join public.skus s on s.id = f.sku_id
    left join vendas v on v.ml_account_id = f.ml_account_id and v.sku_id = f.sku_id
    left join saldo_local l on l.sku_id = f.sku_id
    where p_search is null
       or s.sku ilike '%' || p_search || '%'
       or s.title ilike '%' || p_search || '%'
  ),
  filtrado as (
    select * from base
    where p_situation is null or situation = p_situation
  )
  select f.ml_account_id, f.account_label, f.sku_id, f.sku, f.sku_title,
         f.full_quantity, f.buckets, f.captured_at, f.local_quantity, f.units_sold, f.situation,
         -- Janela sobre o conjunto FILTRADO inteiro, antes do limite.
         count(*) over () as total_count
  from filtrado f
  order by f.full_quantity desc, f.units_sold desc, f.sku
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0)
$$;
