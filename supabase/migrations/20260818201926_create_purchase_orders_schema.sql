-- Purchase order lifecycle schema: suppliers and purchase orders.
--
-- Suppliers are a standalone entity, never inferred from brand or from
-- UpSeller data (near-empty in practice: 9/3424 products with
-- supplier_url, 0 with seller filled in).
--
-- Purchase orders work by physical UpSeller SKU (source_sku_key), the
-- same unit the purchase planning read model already aggregates by.

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) > 0),
  legal_name text,
  document text,
  contact_name text,
  email text,
  phone text,
  whatsapp text,
  website text,
  notes text,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index suppliers_org_name_idx on public.suppliers (organization_id, lower(btrim(name)));
create index suppliers_org_active_idx on public.suppliers (organization_id) where is_active;

create trigger suppliers_set_updated_at before update on public.suppliers
for each row execute function private.set_updated_at();

alter table public.suppliers enable row level security;

create policy suppliers_select_members
on public.suppliers
for select
to authenticated
using (private.is_organization_member(organization_id));

revoke all on public.suppliers from public, anon;
grant select on public.suppliers to authenticated;
grant all on public.suppliers to service_role;

-- Several suppliers may quote the same physical SKU; at most one may be
-- preferred per (organization, sku).
create table public.supplier_product_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  source_sku text not null,
  source_sku_key text not null,
  supplier_sku text,
  is_preferred boolean not null default false,
  last_ordered_unit_cost numeric check (last_ordered_unit_cost is null or last_ordered_unit_cost >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, supplier_id, source_sku_key)
);

create unique index supplier_product_links_one_preferred_idx
on public.supplier_product_links (organization_id, source_sku_key)
where is_preferred;

create index supplier_product_links_org_sku_idx
on public.supplier_product_links (organization_id, source_sku_key);

create trigger supplier_product_links_set_updated_at before update on public.supplier_product_links
for each row execute function private.set_updated_at();

alter table public.supplier_product_links enable row level security;

create policy supplier_product_links_select_members
on public.supplier_product_links
for select
to authenticated
using (private.is_organization_member(organization_id));

revoke all on public.supplier_product_links from public, anon;
grant select on public.supplier_product_links to authenticated;
grant all on public.supplier_product_links to service_role;

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_number bigint generated always as identity,
  supplier_id uuid references public.suppliers(id) on delete restrict,
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'ordered', 'partially_received', 'received', 'cancelled')),
  destination_warehouse_key text,
  destination_warehouse_name text,
  currency text not null default 'BRL' check (currency = 'BRL'),
  notes text,
  transit_accounting_source text not null default 'internal'
    check (transit_accounting_source in ('internal', 'upseller_confirmed')),
  expected_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  ordered_at timestamptz,
  ordered_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete restrict,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, order_number)
);

create index purchase_orders_org_status_idx on public.purchase_orders (organization_id, status);
create index purchase_orders_org_expected_idx on public.purchase_orders (organization_id, expected_at)
where status in ('ordered', 'partially_received');

create trigger purchase_orders_set_updated_at before update on public.purchase_orders
for each row execute function private.set_updated_at();

alter table public.purchase_orders enable row level security;

create policy purchase_orders_select_members
on public.purchase_orders
for select
to authenticated
using (private.is_organization_member(organization_id));

revoke all on public.purchase_orders from public, anon;
grant select on public.purchase_orders to authenticated;
grant all on public.purchase_orders to service_role;

create table public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  source_sku text not null,
  source_sku_key text not null,
  title_snapshot text,
  brand_snapshot text,
  quantity_ordered numeric not null check (quantity_ordered > 0),
  cancelled_quantity numeric not null default 0 check (cancelled_quantity >= 0),
  unit_cost numeric check (unit_cost is null or unit_cost >= 0),
  suggested_quantity_snapshot numeric,
  physical_available_snapshot numeric,
  upseller_purchase_in_transit_snapshot numeric,
  avg_daily_sales_30_snapshot numeric,
  lead_time_days_snapshot integer,
  low_stock_threshold_snapshot numeric,
  projected_stock_at_arrival_snapshot numeric,
  planning_status_snapshot text,
  planning_generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (purchase_order_id, source_sku_key),
  check (cancelled_quantity <= quantity_ordered)
);

create index purchase_order_items_po_idx on public.purchase_order_items (purchase_order_id);
create index purchase_order_items_org_sku_idx on public.purchase_order_items (organization_id, source_sku_key);

create trigger purchase_order_items_set_updated_at before update on public.purchase_order_items
for each row execute function private.set_updated_at();

alter table public.purchase_order_items enable row level security;

create policy purchase_order_items_select_members
on public.purchase_order_items
for select
to authenticated
using (private.is_organization_member(organization_id));

revoke all on public.purchase_order_items from public, anon;
grant select on public.purchase_order_items to authenticated;
grant all on public.purchase_order_items to service_role;

create table public.purchase_order_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  event_type text not null check (event_type in (
    'created', 'updated', 'supplier_changed', 'approved', 'reopened', 'ordered',
    'transit_accounting_changed', 'receipt_linked', 'remaining_cancelled', 'cancelled'
  )),
  actor_user_id uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index purchase_order_events_po_idx on public.purchase_order_events (purchase_order_id, created_at desc);

alter table public.purchase_order_events enable row level security;

create policy purchase_order_events_select_members
on public.purchase_order_events
for select
to authenticated
using (private.is_organization_member(organization_id));

revoke all on public.purchase_order_events from public, anon;
grant select on public.purchase_order_events to authenticated;
grant all on public.purchase_order_events to service_role;

-- Extend the existing NF-e receipt tables so a receipt can optionally be
-- linked to the purchase order it fulfills. Both columns stay nullable: a
-- receipt applied outside of any purchase order keeps working unchanged.
alter table public.stock_receipts
  add column purchase_order_id uuid references public.purchase_orders(id) on delete set null;

alter table public.stock_receipt_items
  add column purchase_order_item_id uuid references public.purchase_order_items(id) on delete set null;

-- Received/outstanding/over-received are always derived from linked
-- receipt items, never stored redundantly on the item row.
create view public.purchase_order_item_progress
with (security_invoker = true)
as
select
  item.id as purchase_order_item_id,
  item.organization_id,
  item.purchase_order_id,
  item.source_sku_key,
  item.quantity_ordered,
  item.cancelled_quantity,
  coalesce(sum(receipt_item.quantity), 0) as received_quantity,
  greatest(item.quantity_ordered - item.cancelled_quantity - coalesce(sum(receipt_item.quantity), 0), 0) as outstanding_quantity,
  greatest(coalesce(sum(receipt_item.quantity), 0) - (item.quantity_ordered - item.cancelled_quantity), 0) as over_received_quantity
from public.purchase_order_items as item
left join public.stock_receipt_items as receipt_item
  on receipt_item.purchase_order_item_id = item.id
group by item.id, item.organization_id, item.purchase_order_id, item.source_sku_key,
  item.quantity_ordered, item.cancelled_quantity;

revoke all on public.purchase_order_item_progress from public, anon;
grant select on public.purchase_order_item_progress to authenticated, service_role;
