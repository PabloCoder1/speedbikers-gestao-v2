-- Visitas por anúncio (D-032, Fase 5B) — pesquisa ao vivo confirmou
-- GET /items/{item_id}/visits/time_window (developers.mercadolivre.com.br,
-- "Visitas", 2026-08-23). "resource" de sync_runs/sync_errors nunca previu
-- 'visits' (só orders/listings/fulfillment, desde a Fase 2) — precisa alargar
-- o CHECK, primeira vez nesta sessão que esse enum precisa crescer de verdade.

alter table public.sync_runs drop constraint sync_runs_resource_check;
alter table public.sync_runs add constraint sync_runs_resource_check
  check (resource = any (array['orders', 'listings', 'fulfillment', 'visits']));

alter table public.sync_errors drop constraint sync_errors_resource_check;
alter table public.sync_errors add constraint sync_errors_resource_check
  check (resource = any (array['orders', 'listings', 'fulfillment', 'visits']));

create table public.daily_listing_visits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ml_account_id uuid not null references public.ml_accounts(id) on delete restrict,
  item_id text not null check (item_id ~ '^MLB[0-9]+$'),
  metric_date date not null,
  visits numeric not null check (visits >= 0),
  synced_at timestamptz not null,
  created_at timestamptz not null default now(),

  unique (ml_account_id, item_id, metric_date)
);

comment on table public.daily_listing_visits is
  'Espelho diário de visitas por anúncio, direto da API de Visitas do Mercado Livre (GET /items/{item_id}/visits/time_window) — não é recomputado do nosso lado, é o valor que o ML devolve. Grão (ml_account_id, item_id, metric_date), mesmo escopo de listings/Full: só itens sem variação (sku_listing_links.ref_kind=ITEM, variation_id is null).';

create index daily_listing_visits_org_idx on public.daily_listing_visits (organization_id);

alter table public.daily_listing_visits enable row level security;

create policy daily_listing_visits_select_own_account
  on public.daily_listing_visits for select
  to authenticated
  using (private.has_account_access(ml_account_id));

revoke all on public.daily_listing_visits from anon;
grant select on public.daily_listing_visits to authenticated;
grant all on public.daily_listing_visits to service_role;

create function public.get_listing_traffic(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  ml_account_id uuid,
  item_id text,
  visits numeric,
  orders_count bigint,
  conversion_rate numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with visits as (
    select v.ml_account_id, v.item_id, sum(v.visits) as visits
    from public.daily_listing_visits v
    where v.organization_id = p_organization_id
      and v.metric_date between p_date_from and p_date_to
    group by v.ml_account_id, v.item_id
  ),
  orders as (
    select m.ml_account_id, m.mlb_id as item_id, sum(m.orders_count) as orders_count
    from public.daily_listing_metrics m
    where m.organization_id = p_organization_id
      and m.variation_id is null
      and m.metric_date between p_date_from and p_date_to
    group by m.ml_account_id, m.mlb_id
  )
  select
    coalesce(v.ml_account_id, o.ml_account_id) as ml_account_id,
    coalesce(v.item_id, o.item_id) as item_id,
    coalesce(v.visits, 0) as visits,
    coalesce(o.orders_count, 0)::bigint as orders_count,
    case
      when coalesce(v.visits, 0) = 0 then null
      else round(coalesce(o.orders_count, 0)::numeric / v.visits * 100, 2)
    end as conversion_rate
  from visits v
  full outer join orders o on o.ml_account_id = v.ml_account_id and o.item_id = v.item_id
$$;

comment on function public.get_listing_traffic(uuid, date, date) is
  'Visitas somadas e conversão por anúncio (D-032, Fase 5B) — full outer join entre daily_listing_visits (visitas, do ML) e daily_listing_metrics (pedidos, do nosso ledger de vendas), mesmo padrão de get_stock_coverage. conversion_rate = pedidos / visitas * 100, NULL (não Infinity) quando não há visita no período. Consumida por /anuncios, cruzada com get_listing_sales/listings por chave (ml_account_id, item_id) em JS — junção, não agregação, a soma já veio pronta do RPC.';

revoke all on function public.get_listing_traffic(uuid, date, date) from public, anon;
grant execute on function public.get_listing_traffic(uuid, date, date) to authenticated, service_role;
