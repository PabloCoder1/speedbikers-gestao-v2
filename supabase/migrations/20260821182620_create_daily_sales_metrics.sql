-- ============================================================
-- Metricas diarias de venda — fato por anuncio + dois rollups (D-017/D-050).
--
-- L3 analitico e recomputavel: estas tabelas nunca sao fonte unica. Esta
-- migration cria o schema e o calculo canonico compartilhado, mas NAO roda o
-- rebuild historico — o backfill de pedidos de 12 meses ainda esta em curso.
--
-- Medidas distintas sao calculadas diretamente em cada grao pelo mesmo
-- GROUPING SETS. Em especial, purchases_count nao e a soma da contagem por
-- anuncio: pedidos do mesmo pack podem pertencer a anuncios diferentes.
-- ============================================================

-- ============================================================
-- 1. Fato diario por anuncio
--
-- Grao aprovado em D-017:
-- (ml_account_id, mlb_id, variation_id, metric_date).
-- NULLS NOT DISTINCT faz anuncio sem variacao continuar tendo uma unica linha.
-- ============================================================

create table public.daily_listing_metrics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ml_account_id uuid not null references public.ml_accounts(id) on delete restrict,
  mlb_id text not null check (mlb_id ~ '^MLB[0-9]+$'),
  variation_id text check (variation_id ~ '^[0-9]+$'),
  metric_date date not null,

  units_sold bigint not null check (units_sold > 0),
  gross_revenue numeric not null check (gross_revenue >= 0),
  orders_count bigint not null check (orders_count > 0),
  purchases_count bigint not null check (purchases_count > 0),

  average_ticket numeric generated always as (
    round(gross_revenue / nullif(purchases_count, 0), 2)
  ) stored,
  average_selling_price numeric generated always as (
    round(gross_revenue / nullif(units_sold, 0), 2)
  ) stored,

  computed_at timestamptz not null default now(),

  constraint daily_listing_metrics_grain_unique
    unique nulls not distinct (ml_account_id, mlb_id, variation_id, metric_date)
);

comment on table public.daily_listing_metrics is
  'L3 recomputavel. Fato diario de vendas no grao conta + anuncio + variacao + dia de negocio.';

comment on column public.daily_listing_metrics.metric_date is
  'Dia civil de orders.date_created em America/Sao_Paulo (D-050).';

comment on column public.daily_listing_metrics.purchases_count is
  'COUNT DISTINCT da chave tipada pack:<id>/order:<id>, calculado diretamente neste grao.';

create index daily_listing_metrics_account_date_idx
  on public.daily_listing_metrics (organization_id, ml_account_id, metric_date desc);

-- ============================================================
-- 2. Rollup diario por SKU e conta
--
-- ml_account_id permanece no grao para que a RLS respeite permissoes por
-- conta. sku_id e anulavel de proposito: o bucket nao vinculado permanece no
-- faturamento (D-050). NULLS NOT DISTINCT garante um unico bucket nulo/dia.
-- ============================================================

create table public.daily_sku_metrics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ml_account_id uuid not null references public.ml_accounts(id) on delete restrict,
  sku_id uuid references public.skus(id) on delete restrict,
  metric_date date not null,

  units_sold bigint not null check (units_sold > 0),
  gross_revenue numeric not null check (gross_revenue >= 0),
  orders_count bigint not null check (orders_count > 0),
  purchases_count bigint not null check (purchases_count > 0),

  average_ticket numeric generated always as (
    round(gross_revenue / nullif(purchases_count, 0), 2)
  ) stored,
  average_selling_price numeric generated always as (
    round(gross_revenue / nullif(units_sold, 0), 2)
  ) stored,

  computed_at timestamptz not null default now(),

  constraint daily_sku_metrics_grain_unique
    unique nulls not distinct (ml_account_id, sku_id, metric_date)
);

comment on table public.daily_sku_metrics is
  'L3 recomputavel. Rollup diario no grao conta + SKU (inclui bucket sku_id NULL) + dia de negocio.';

comment on column public.daily_sku_metrics.sku_id is
  'Dimensao congelada em order_items. NULL e um bucket valido, nunca faturamento descartado.';

create index daily_sku_metrics_account_date_idx
  on public.daily_sku_metrics (organization_id, ml_account_id, metric_date desc);

create index daily_sku_metrics_sku_date_idx
  on public.daily_sku_metrics (organization_id, sku_id, metric_date desc)
  where sku_id is not null;

-- ============================================================
-- 3. Rollup diario por conta
-- ============================================================

create table public.daily_account_metrics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ml_account_id uuid not null references public.ml_accounts(id) on delete restrict,
  metric_date date not null,

  units_sold bigint not null check (units_sold > 0),
  gross_revenue numeric not null check (gross_revenue >= 0),
  orders_count bigint not null check (orders_count > 0),
  purchases_count bigint not null check (purchases_count > 0),

  average_ticket numeric generated always as (
    round(gross_revenue / nullif(purchases_count, 0), 2)
  ) stored,
  average_selling_price numeric generated always as (
    round(gross_revenue / nullif(units_sold, 0), 2)
  ) stored,

  computed_at timestamptz not null default now(),

  constraint daily_account_metrics_grain_unique
    unique (ml_account_id, metric_date)
);

comment on table public.daily_account_metrics is
  'L3 recomputavel. Rollup diario no grao conta + dia de negocio.';

create index daily_account_metrics_org_date_idx
  on public.daily_account_metrics (organization_id, metric_date desc);

-- ============================================================
-- 4. Calculo canonico compartilhado
--
-- Retorna os tres graos em uma unica consulta. Funcao privada, SECURITY
-- INVOKER e search_path vazio: o futuro procedimento de recomputacao podera
-- reutiliza-la sem criar uma segunda copia das formulas.
-- ============================================================

create function private.compute_daily_sales_metrics(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null
)
returns table (
  metric_grain text,
  organization_id uuid,
  ml_account_id uuid,
  mlb_id text,
  variation_id text,
  sku_id uuid,
  metric_date date,
  units_sold bigint,
  gross_revenue numeric,
  orders_count bigint,
  purchases_count bigint,
  average_ticket numeric,
  average_selling_price numeric
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with valid_sales as (
    select
      o.organization_id,
      o.ml_account_id,
      oi.item_id as mlb_id,
      oi.variation_id,
      oi.sku_id,
      (o.date_created at time zone 'America/Sao_Paulo')::date as metric_date,
      oi.quantity::bigint as units_sold,
      o.total_amount as gross_revenue,
      o.id as order_id,
      case
        when o.pack_id is null then 'order:' || o.id::text
        else 'pack:' || o.pack_id::text
      end as purchase_key
    from public.orders o
    join public.order_items oi
      on oi.order_id = o.id
     and oi.organization_id = o.organization_id
     and oi.ml_account_id = o.ml_account_id
    where o.organization_id = p_organization_id
      and (p_ml_account_id is null or o.ml_account_id = p_ml_account_id)
      and p_date_from <= p_date_to
      and o.status in ('paid', 'partially_refunded')
      and o.date_created >= (p_date_from::timestamp at time zone 'America/Sao_Paulo')
      and o.date_created < ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo')
  ),
  aggregated as (
    select
      case
        when grouping(v.mlb_id) = 0 then 'listing'
        when grouping(v.sku_id) = 0 then 'sku'
        else 'account'
      end as metric_grain,
      v.organization_id,
      v.ml_account_id,
      case when grouping(v.mlb_id) = 0 then v.mlb_id end as mlb_id,
      case when grouping(v.variation_id) = 0 then v.variation_id end as variation_id,
      case when grouping(v.sku_id) = 0 then v.sku_id end as sku_id,
      v.metric_date,
      sum(v.units_sold)::bigint as units_sold,
      round(sum(v.gross_revenue), 2) as gross_revenue,
      count(distinct v.order_id)::bigint as orders_count,
      count(distinct v.purchase_key)::bigint as purchases_count
    from valid_sales v
    group by grouping sets (
      (
        v.organization_id,
        v.ml_account_id,
        v.mlb_id,
        v.variation_id,
        v.metric_date
      ),
      (
        v.organization_id,
        v.ml_account_id,
        v.sku_id,
        v.metric_date
      ),
      (
        v.organization_id,
        v.ml_account_id,
        v.metric_date
      )
    )
  )
  select
    a.metric_grain,
    a.organization_id,
    a.ml_account_id,
    a.mlb_id,
    a.variation_id,
    a.sku_id,
    a.metric_date,
    a.units_sold,
    a.gross_revenue,
    a.orders_count,
    a.purchases_count,
    round(a.gross_revenue / nullif(a.purchases_count, 0), 2) as average_ticket,
    round(a.gross_revenue / nullif(a.units_sold, 0), 2) as average_selling_price
  from aggregated a;
$function$;

comment on function private.compute_daily_sales_metrics(uuid, date, date, uuid) is
  'Calculo canonico D-017/D-050 para anuncio, SKU e conta. Sempre agrega direto de orders/order_items.';

revoke all on function private.compute_daily_sales_metrics(uuid, date, date, uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.compute_daily_sales_metrics(uuid, date, date, uuid)
  to service_role;

-- ============================================================
-- 5. RLS e privilegios
--
-- Leitura direta do web sob RLS (D-012). Escrita e exclusivamente do futuro
-- job de recomputacao via service_role. Nao existe policy de escrita humana.
-- ============================================================

alter table public.daily_listing_metrics enable row level security;
alter table public.daily_sku_metrics enable row level security;
alter table public.daily_account_metrics enable row level security;

create policy daily_listing_metrics_select_permitted
  on public.daily_listing_metrics for select to authenticated
  using (private.has_account_access(ml_account_id));

create policy daily_sku_metrics_select_permitted
  on public.daily_sku_metrics for select to authenticated
  using (private.has_account_access(ml_account_id));

create policy daily_account_metrics_select_permitted
  on public.daily_account_metrics for select to authenticated
  using (private.has_account_access(ml_account_id));

revoke all on public.daily_listing_metrics from anon, authenticated, service_role;
revoke all on public.daily_sku_metrics from anon, authenticated, service_role;
revoke all on public.daily_account_metrics from anon, authenticated, service_role;

grant select on public.daily_listing_metrics,
                public.daily_sku_metrics,
                public.daily_account_metrics
  to authenticated;

grant select, insert, update, delete on public.daily_listing_metrics,
                                        public.daily_sku_metrics,
                                        public.daily_account_metrics
  to service_role;
