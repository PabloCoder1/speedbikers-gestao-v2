-- ============================================================
-- Speed Bikers Gestão V2
-- Orders and order items
-- ============================================================


-- ============================================================
-- 1. ORDERS
-- ============================================================

create table public.orders (
  id uuid primary key
    default gen_random_uuid(),

  organization_id uuid not null,

  ml_account_id uuid not null,

  external_order_id text not null
    check (
      external_order_id ~ '^[0-9]+$'
    ),

  pack_id text,

  status text,

  total_amount numeric(18, 2),

  paid_amount numeric(18, 2),

  currency_id text,

  shipping_id text,

  tags jsonb not null
    default '[]'::jsonb,

  date_created timestamptz,

  date_closed timestamptz,

  ml_last_updated timestamptz,

  raw_payload jsonb not null
    default '{}'::jsonb,

  first_seen_at timestamptz not null
    default now(),

  last_seen_at timestamptz not null
    default now(),

  last_seen_sync_run_id uuid not null,

  created_at timestamptz not null
    default now(),

  updated_at timestamptz not null
    default now(),

  constraint orders_account_fk
    foreign key (
      organization_id,
      ml_account_id
    )
    references public.ml_accounts (
      organization_id,
      id
    )
    on delete cascade,

  constraint orders_sync_run_fk
    foreign key (
      organization_id,
      ml_account_id,
      last_seen_sync_run_id
    )
    references public.sync_runs (
      organization_id,
      ml_account_id,
      id
    ),

  constraint orders_account_external_unique
    unique (
      ml_account_id,
      external_order_id
    ),

  constraint orders_org_account_id_unique
    unique (
      organization_id,
      ml_account_id,
      id
    )
);


create index orders_account_date_idx
on public.orders (
  ml_account_id,
  date_created desc
);


create index orders_status_idx
on public.orders (
  ml_account_id,
  status
);


create index orders_pack_idx
on public.orders (
  ml_account_id,
  pack_id
)
where pack_id is not null;


create trigger orders_set_updated_at
before update on public.orders
for each row
execute function private.set_updated_at();


-- ============================================================
-- 2. ORDER ITEMS
-- ============================================================

create table public.order_items (
  id uuid primary key
    default gen_random_uuid(),

  organization_id uuid not null,

  ml_account_id uuid not null,

  order_id uuid not null,

  ml_listing_id uuid,

  product_id uuid,

  -- Stable application key inside one order.
  line_key text not null,

  item_id text not null,

  variation_id text,

  seller_sku text,

  title text,

  quantity integer not null
    check (
      quantity > 0
    ),

  unit_price numeric(18, 2),

  full_unit_price numeric(18, 2),

  sale_fee numeric(18, 2),

  currency_id text,

  is_current boolean not null
    default true,

  raw_payload jsonb not null
    default '{}'::jsonb,

  first_seen_at timestamptz not null
    default now(),

  last_seen_at timestamptz not null
    default now(),

  last_seen_sync_run_id uuid not null,

  created_at timestamptz not null
    default now(),

  updated_at timestamptz not null
    default now(),

  constraint order_items_order_fk
    foreign key (
      organization_id,
      ml_account_id,
      order_id
    )
    references public.orders (
      organization_id,
      ml_account_id,
      id
    )
    on delete cascade,

  constraint order_items_listing_fk
    foreign key (
      organization_id,
      ml_account_id,
      ml_listing_id
    )
    references public.ml_listings (
      organization_id,
      ml_account_id,
      id
    )
    on delete set null,

  constraint order_items_product_fk
    foreign key (
      organization_id,
      product_id
    )
    references public.products (
      organization_id,
      id
    )
    on delete set null,

  constraint order_items_sync_run_fk
    foreign key (
      organization_id,
      ml_account_id,
      last_seen_sync_run_id
    )
    references public.sync_runs (
      organization_id,
      ml_account_id,
      id
    ),

  constraint order_items_order_line_unique
    unique (
      order_id,
      line_key
    )
);


create index order_items_order_idx
on public.order_items (
  order_id
);


create index order_items_product_idx
on public.order_items (
  product_id
);


create index order_items_listing_idx
on public.order_items (
  ml_listing_id
);


create index order_items_sku_idx
on public.order_items (
  organization_id,
  seller_sku
)
where seller_sku is not null;


create index order_items_item_idx
on public.order_items (
  ml_account_id,
  item_id
);


create trigger order_items_set_updated_at
before update on public.order_items
for each row
execute function private.set_updated_at();


-- ============================================================
-- 3. RLS
-- ============================================================

alter table public.orders
enable row level security;

alter table public.order_items
enable row level security;


revoke all
on public.orders
from anon;

revoke all
on public.order_items
from anon;


revoke all
on public.orders
from authenticated;

revoke all
on public.order_items
from authenticated;


grant select
on public.orders
to authenticated;

grant select
on public.order_items
to authenticated;


create policy "users can view permitted orders"
on public.orders
for select
to authenticated
using (
  private.can_access_ml_account(
    ml_account_id
  )
);


create policy "users can view permitted order items"
on public.order_items
for select
to authenticated
using (
  private.can_access_ml_account(
    ml_account_id
  )
);