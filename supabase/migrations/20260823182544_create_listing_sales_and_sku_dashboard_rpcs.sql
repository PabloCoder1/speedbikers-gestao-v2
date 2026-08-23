create function public.get_listing_sales(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  ml_account_id uuid,
  mlb_id text,
  units_sold bigint,
  gross_revenue numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    m.ml_account_id,
    m.mlb_id,
    sum(m.units_sold)::bigint as units_sold,
    sum(m.gross_revenue) as gross_revenue
  from public.daily_listing_metrics m
  where m.organization_id = p_organization_id
    and m.variation_id is null
    and m.metric_date between p_date_from and p_date_to
  group by m.ml_account_id, m.mlb_id
$$;

comment on function public.get_listing_sales(uuid, date, date) is
  'Venda somada por anúncio (ml_account_id + mlb_id) num intervalo — consumida por /anuncios para cruzar com listings.item_id (mesmo espaço de valores, mesma restrição de escopo: só itens sem variação, igual sync.listings.snapshot). Soma em SQL, nunca em JS (docs/ARCHITECTURE.md secao 21).';

revoke all on function public.get_listing_sales(uuid, date, date) from public, anon;
grant execute on function public.get_listing_sales(uuid, date, date) to authenticated, service_role;

create function public.get_sku_dashboard(
  p_organization_id uuid,
  p_sku_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  local_quantity numeric,
  reservado_quantity numeric,
  transito_quantity numeric,
  full_quantity numeric,
  units_sold bigint,
  gross_revenue numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with balances as (
    select location_kind, quantity
    from public.inventory_balances
    where organization_id = p_organization_id and sku_id = p_sku_id
  ),
  sales as (
    select
      coalesce(sum(units_sold), 0)::bigint as units_sold,
      coalesce(sum(gross_revenue), 0) as gross_revenue
    from public.daily_sku_metrics
    where organization_id = p_organization_id
      and sku_id = p_sku_id
      and metric_date between p_date_from and p_date_to
  ),
  latest_full as (
    select distinct on (f.ml_account_id, f.item_id, f.variation_id) f.quantity
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id and f.sku_id = p_sku_id
    order by f.ml_account_id, f.item_id, f.variation_id, f.captured_at desc
  ),
  full_total as (
    select coalesce(sum(quantity), 0) as full_quantity from latest_full
  )
  select
    coalesce((select quantity from balances where location_kind = 'LOCAL'), 0) as local_quantity,
    coalesce((select quantity from balances where location_kind = 'RESERVADO'), 0) as reservado_quantity,
    coalesce((select quantity from balances where location_kind = 'TRANSITO'), 0) as transito_quantity,
    full_total.full_quantity,
    sales.units_sold,
    sales.gross_revenue
  from sales cross join full_total
$$;

comment on function public.get_sku_dashboard(uuid, uuid, date, date) is
  '"Dashboard de SKU" (Fase 5B) — resumo de um SKU num intervalo: estoque LOCAL/RESERVADO/TRANSITO (inventory_balances, projeção atual, sem filtro de data), estoque em Full (último snapshot conhecido por conta, mesmo distinct on de get_sku_abc_curve) e venda somada no intervalo (daily_sku_metrics). Sempre devolve UMA linha (agregados sem GROUP BY, mesmo padrão de get_sales_summary) mesmo para SKU sem movimento nenhum — zeros, não linha ausente. Listings do SKU são consultados à parte pela página, sem agregação (select direto, RLS já filtra).';

revoke all on function public.get_sku_dashboard(uuid, uuid, date, date) from public, anon;
grant execute on function public.get_sku_dashboard(uuid, uuid, date, date) to authenticated, service_role;
