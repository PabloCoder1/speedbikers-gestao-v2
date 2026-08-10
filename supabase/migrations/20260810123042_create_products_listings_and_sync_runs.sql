-- ============================================================
-- Speed Bikers Gestão V2
-- Products, Mercado Livre listings and sync runs
-- ============================================================


-- ============================================================
-- 1. PRODUCTS
--
-- SKU is the central commercial entity of the platform.
-- ============================================================

create table public.products (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id)
    on delete cascade,

  sku text not null
    check (
      char_length(btrim(sku))
      between 1 and 120
    ),

  -- Normalized internal identity.
  -- The original SKU is preserved in `sku`.
  sku_key text not null
    check (
      sku_key = upper(btrim(sku_key))
      and char_length(sku_key)
        between 1 and 120
    ),

  name text,

  created_at timestamptz not null
    default now(),

  updated_at timestamptz not null
    default now(),

  constraint products_organization_sku_unique
    unique (
      organization_id,
      sku_key
    ),

  constraint products_organization_id_id_unique
    unique (
      organization_id,
      id
    )
);

comment on table public.products is
  'Canonical organization products identified primarily by internal SKU.';

create index products_organization_idx
  on public.products (
    organization_id
  );

create index products_sku_key_idx
  on public.products (
    organization_id,
    sku_key
  );

create trigger products_set_updated_at
before update on public.products
for each row
execute function private.set_updated_at();


-- ============================================================
-- 2. SYNC RUNS
--
-- Every synchronization attempt becomes auditable.
-- ============================================================

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null,

  ml_account_id uuid not null,

  sync_type text not null
    check (
      char_length(btrim(sync_type))
      between 1 and 80
    ),

  status text not null
    default 'running'
    check (
      status in (
        'running',
        'succeeded',
        'failed',
        'partial'
      )
    ),

  records_discovered integer not null
    default 0
    check (
      records_discovered >= 0
    ),

  records_processed integer not null
    default 0
    check (
      records_processed >= 0
    ),

  records_upserted integer not null
    default 0
    check (
      records_upserted >= 0
    ),

  error_code text,
  error_message text,

  metadata jsonb not null
    default '{}'::jsonb,

  started_at timestamptz not null
    default now(),

  finished_at timestamptz,

  constraint sync_runs_account_fk
    foreign key (
      organization_id,
      ml_account_id
    )
    references public.ml_accounts (
      organization_id,
      id
    )
    on delete cascade,

  constraint sync_runs_organization_account_id_unique
    unique (
      organization_id,
      ml_account_id,
      id
    )
);

create index sync_runs_account_started_idx
  on public.sync_runs (
    ml_account_id,
    started_at desc
  );

create index sync_runs_status_idx
  on public.sync_runs (
    status,
    started_at
  );


-- ============================================================
-- 3. MERCADO LIVRE LISTINGS
--
-- One row = one MLB advertisement.
-- ============================================================

create table public.ml_listings (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null,

  ml_account_id uuid not null,

  product_id uuid,

  item_id text not null
    check (
      item_id ~ '^[A-Z]{3}[0-9]+$'
    ),

  user_product_id text,

  title text,

  seller_sku text,

  category_id text,

  domain_id text,

  catalog_product_id text,

  listing_type_id text,

  status text,

  sub_status jsonb not null
    default '[]'::jsonb,

  price numeric(18, 2),

  currency_id text,

  initial_quantity integer,

  available_quantity integer,

  sold_quantity integer,

  health numeric(8, 4),

  catalog_listing boolean,

  permalink text,

  thumbnail text,

  date_created timestamptz,

  ml_last_updated timestamptz,

  raw_payload jsonb not null
    default '{}'::jsonb,

  is_current boolean not null
    default true,

  first_seen_at timestamptz not null
    default now(),

  last_seen_at timestamptz not null
    default now(),

  last_seen_sync_run_id uuid not null,

  created_at timestamptz not null
    default now(),

  updated_at timestamptz not null
    default now(),

  constraint ml_listings_account_fk
    foreign key (
      organization_id,
      ml_account_id
    )
    references public.ml_accounts (
      organization_id,
      id
    )
    on delete cascade,

  constraint ml_listings_product_fk
    foreign key (
      organization_id,
      product_id
    )
    references public.products (
      organization_id,
      id
    )
    on delete set null,

  constraint ml_listings_sync_run_fk
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

  constraint ml_listings_account_item_unique
    unique (
      ml_account_id,
      item_id
    ),

  constraint ml_listings_org_account_id_unique
    unique (
      organization_id,
      ml_account_id,
      id
    )
);

create index ml_listings_account_idx
  on public.ml_listings (
    ml_account_id
  );

create index ml_listings_product_idx
  on public.ml_listings (
    product_id
  );

create index ml_listings_item_idx
  on public.ml_listings (
    item_id
  );

create index ml_listings_seller_sku_idx
  on public.ml_listings (
    organization_id,
    seller_sku
  )
  where seller_sku is not null;

create index ml_listings_status_idx
  on public.ml_listings (
    ml_account_id,
    status
  );

create trigger ml_listings_set_updated_at
before update on public.ml_listings
for each row
execute function private.set_updated_at();


-- ============================================================
-- 4. LISTING VARIATIONS
--
-- A variation may carry its own SKU and therefore point to a
-- different canonical product.
-- ============================================================

create table public.ml_listing_variations (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null,

  ml_account_id uuid not null,

  ml_listing_id uuid not null,

  product_id uuid,

  variation_id text not null,

  seller_sku text,

  price numeric(18, 2),

  available_quantity integer,

  sold_quantity integer,

  attribute_combinations jsonb not null
    default '[]'::jsonb,

  raw_payload jsonb not null
    default '{}'::jsonb,

  is_current boolean not null
    default true,

  first_seen_at timestamptz not null
    default now(),

  last_seen_at timestamptz not null
    default now(),

  last_seen_sync_run_id uuid not null,

  created_at timestamptz not null
    default now(),

  updated_at timestamptz not null
    default now(),

  constraint ml_listing_variations_listing_fk
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
    on delete cascade,

  constraint ml_listing_variations_product_fk
    foreign key (
      organization_id,
      product_id
    )
    references public.products (
      organization_id,
      id
    )
    on delete set null,

  constraint ml_listing_variations_sync_run_fk
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

  constraint ml_listing_variations_unique
    unique (
      ml_listing_id,
      variation_id
    )
);

create index ml_listing_variations_listing_idx
  on public.ml_listing_variations (
    ml_listing_id
  );

create index ml_listing_variations_product_idx
  on public.ml_listing_variations (
    product_id
  );

create index ml_listing_variations_sku_idx
  on public.ml_listing_variations (
    organization_id,
    seller_sku
  )
  where seller_sku is not null;

create trigger ml_listing_variations_set_updated_at
before update on public.ml_listing_variations
for each row
execute function private.set_updated_at();


-- ============================================================
-- 5. RLS
-- ============================================================

alter table public.products
enable row level security;

alter table public.sync_runs
enable row level security;

alter table public.ml_listings
enable row level security;

alter table public.ml_listing_variations
enable row level security;


-- ============================================================
-- 6. PRIVILEGES
-- ============================================================

revoke all
on public.products
from anon;

revoke all
on public.sync_runs
from anon;

revoke all
on public.ml_listings
from anon;

revoke all
on public.ml_listing_variations
from anon;


revoke all
on public.products
from authenticated;

revoke all
on public.sync_runs
from authenticated;

revoke all
on public.ml_listings
from authenticated;

revoke all
on public.ml_listing_variations
from authenticated;


grant select
on public.products
to authenticated;

grant select
on public.sync_runs
to authenticated;

grant select
on public.ml_listings
to authenticated;

grant select
on public.ml_listing_variations
to authenticated;


-- ============================================================
-- 7. RLS POLICIES
-- ============================================================

create policy "organization members can view products"
on public.products
for select
to authenticated
using (
  private.is_organization_member(
    organization_id
  )
);


create policy "users can view permitted sync runs"
on public.sync_runs
for select
to authenticated
using (
  private.can_access_ml_account(
    ml_account_id
  )
);


create policy "users can view permitted listings"
on public.ml_listings
for select
to authenticated
using (
  private.can_access_ml_account(
    ml_account_id
  )
);


create policy "users can view permitted listing variations"
on public.ml_listing_variations
for select
to authenticated
using (
  private.can_access_ml_account(
    ml_account_id
  )
);