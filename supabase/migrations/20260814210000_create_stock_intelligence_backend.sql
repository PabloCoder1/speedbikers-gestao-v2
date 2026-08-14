-- Speed Bikers Gestão V2 — stock intelligence foundations.

alter table public.ml_listings
  add column if not exists inventory_id text;

alter table public.ml_listing_variations
  add column if not exists inventory_id text,
  add column if not exists user_product_id text;

update public.ml_listings
set inventory_id = nullif(btrim(raw_payload ->> 'inventory_id'), '')
where inventory_id is null
  and nullif(btrim(raw_payload ->> 'inventory_id'), '') is not null;

update public.ml_listings
set user_product_id = nullif(btrim(raw_payload ->> 'user_product_id'), '')
where user_product_id is null
  and nullif(btrim(raw_payload ->> 'user_product_id'), '') is not null;

update public.ml_listing_variations
set inventory_id = nullif(btrim(raw_payload ->> 'inventory_id'), ''),
    user_product_id = nullif(btrim(raw_payload ->> 'user_product_id'), '')
where (inventory_id is null or user_product_id is null)
  and (
    nullif(btrim(raw_payload ->> 'inventory_id'), '') is not null
    or nullif(btrim(raw_payload ->> 'user_product_id'), '') is not null
  );

create index if not exists ml_listings_inventory_idx
  on public.ml_listings (organization_id, ml_account_id, inventory_id)
  where is_current and inventory_id is not null;

create index if not exists ml_listing_variations_inventory_idx
  on public.ml_listing_variations (organization_id, ml_account_id, inventory_id)
  where is_current and inventory_id is not null;

create index if not exists ml_listings_user_product_idx
  on public.ml_listings (organization_id, ml_account_id, user_product_id)
  where is_current and user_product_id is not null;

create index if not exists ml_listing_variations_user_product_idx
  on public.ml_listing_variations (organization_id, ml_account_id, user_product_id)
  where is_current and user_product_id is not null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'upseller-imports',
  'upseller-imports',
  false,
  26214400,
  array[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip',
    'application/x-zip-compressed',
    'application/octet-stream'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table public.upseller_import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  status text not null default 'previewed' check (status in ('previewed','queued','running','applied','failed','cancelled')),
  import_fingerprint text not null check (char_length(import_fingerprint) = 64),
  stock_file_hash text check (stock_file_hash is null or char_length(stock_file_hash) = 64),
  relationship_file_hash text check (relationship_file_hash is null or char_length(relationship_file_hash) = 64),
  warehouse_zip_hash text check (warehouse_zip_hash is null or char_length(warehouse_zip_hash) = 64),
  stock_storage_path text,
  relationship_storage_path text,
  warehouse_zip_storage_path text,
  phase text,
  cursor_row integer not null default 0 check (cursor_row >= 0),
  lease_id uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  preview_summary jsonb not null default '{}'::jsonb,
  validation_issues jsonb not null default '{"blockingIssues":[],"warnings":[]}'::jsonb,
  error_code text,
  error_message text,
  requested_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  applied_at timestamptz,
  unique (organization_id, import_fingerprint),
  unique (organization_id, id),
  check ((lease_id is null and lease_expires_at is null) or (lease_id is not null and lease_expires_at is not null))
);

create index upseller_import_batches_queue_idx
  on public.upseller_import_batches (status, next_attempt_at, created_at)
  where status in ('queued','running');

create trigger upseller_import_batches_set_updated_at
before update on public.upseller_import_batches
for each row execute function private.set_updated_at();

create table public.upseller_stock_import_rows (
  import_id uuid not null,
  organization_id uuid not null,
  row_number integer not null check (row_number > 0),
  source_sku text not null,
  sku_key text not null,
  title text,
  warehouse_name text not null,
  warehouse_key text not null,
  shelf text,
  low_stock_threshold numeric not null check (low_stock_threshold >= 0),
  purchase_in_transit numeric not null check (purchase_in_transit >= 0),
  transfer_in_transit numeric not null check (transfer_in_transit >= 0),
  occupied_quantity numeric not null check (occupied_quantity >= 0),
  available_quantity numeric not null check (available_quantity >= 0),
  current_quantity numeric not null check (current_quantity >= 0),
  average_cost numeric check (average_cost is null or average_cost >= 0),
  stock_value numeric check (stock_value is null or stock_value >= 0),
  source_created_at_raw text,
  state_hash text not null check (char_length(state_hash) = 64),
  row_hash text not null check (char_length(row_hash) = 64),
  raw_payload jsonb not null default '{}'::jsonb,
  primary key (import_id, row_number),
  unique (import_id, sku_key, warehouse_key),
  foreign key (organization_id, import_id) references public.upseller_import_batches(organization_id, id) on delete cascade
);

create table public.upseller_product_import_rows (
  import_id uuid not null,
  organization_id uuid not null,
  row_number integer not null check (row_number > 0),
  source_sku text not null,
  sku_key text not null,
  spu text,
  product_code text,
  title text,
  product_alias text,
  invoice_alias_enabled boolean,
  category text,
  variant_dimensions jsonb not null default '[]'::jsonb,
  launch_date_raw text,
  is_active boolean,
  seller text,
  retail_price numeric check (retail_price is null or retail_price >= 0),
  purchase_cost numeric check (purchase_cost is null or purchase_cost >= 0),
  description text,
  brand text,
  barcodes jsonb not null default '[]'::jsonb,
  sku_alias text,
  images jsonb not null default '[]'::jsonb,
  weight_g numeric check (weight_g is null or weight_g >= 0),
  length_cm numeric check (length_cm is null or length_cm >= 0),
  width_cm numeric check (width_cm is null or width_cm >= 0),
  height_cm numeric check (height_cm is null or height_cm >= 0),
  ncm text,
  cest text,
  unit text,
  origin text,
  supplier_url text,
  row_hash text not null check (char_length(row_hash) = 64),
  raw_payload jsonb not null default '{}'::jsonb,
  primary key (import_id, row_number),
  unique (import_id, sku_key),
  foreign key (organization_id, import_id) references public.upseller_import_batches(organization_id, id) on delete cascade
);

create table public.upseller_relationship_import_rows (
  import_id uuid not null,
  organization_id uuid not null,
  row_number integer not null check (row_number > 0),
  source_sku text not null,
  source_sku_key text not null,
  mapped_listing_sku text,
  mapped_listing_sku_key text,
  variant_label text,
  listing_external_id text,
  variant_external_id text,
  store_name text not null,
  store_name_key text not null,
  channel text not null check (channel in ('mercado_livre','shopee','kwai','temu','tiktok','unknown')),
  source_updated_at_raw text,
  row_hash text not null check (char_length(row_hash) = 64),
  raw_payload jsonb not null default '{}'::jsonb,
  primary key (import_id, row_number),
  foreign key (organization_id, import_id) references public.upseller_import_batches(organization_id, id) on delete cascade
);

create table public.upseller_kit_component_import_rows (
  import_id uuid not null,
  organization_id uuid not null,
  row_number integer not null check (row_number > 0),
  kit_sku text not null,
  kit_sku_key text not null,
  title text,
  alias text,
  invoice_alias_enabled boolean,
  category text,
  is_active boolean,
  image_url text,
  component_sku text not null,
  component_sku_key text not null,
  required_quantity integer not null check (required_quantity > 0),
  row_hash text not null check (char_length(row_hash) = 64),
  raw_payload jsonb not null default '{}'::jsonb,
  primary key (import_id, row_number),
  foreign key (organization_id, import_id) references public.upseller_import_batches(organization_id, id) on delete cascade
);

create table public.upseller_stock_states (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_sku text not null,
  sku_key text not null,
  title text,
  warehouse_name text not null,
  warehouse_key text not null,
  shelf text,
  low_stock_threshold numeric not null check (low_stock_threshold >= 0),
  purchase_in_transit numeric not null check (purchase_in_transit >= 0),
  transfer_in_transit numeric not null check (transfer_in_transit >= 0),
  occupied_quantity numeric not null check (occupied_quantity >= 0),
  available_quantity numeric not null check (available_quantity >= 0),
  current_quantity numeric not null check (current_quantity >= 0),
  average_cost numeric check (average_cost is null or average_cost >= 0),
  stock_value numeric check (stock_value is null or stock_value >= 0),
  source_created_at_raw text,
  state_hash text not null check (char_length(state_hash) = 64),
  source_import_id uuid not null references public.upseller_import_batches(id),
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, sku_key, warehouse_key)
);

create index upseller_stock_states_sku_idx on public.upseller_stock_states (organization_id, sku_key);
create trigger upseller_stock_states_set_updated_at before update on public.upseller_stock_states
for each row execute function private.set_updated_at();

create table public.upseller_stock_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_sku text not null,
  sku_key text not null,
  warehouse_name text not null,
  warehouse_key text not null,
  low_stock_threshold numeric not null,
  purchase_in_transit numeric not null,
  transfer_in_transit numeric not null,
  occupied_quantity numeric not null,
  available_quantity numeric not null,
  current_quantity numeric not null,
  average_cost numeric,
  stock_value numeric,
  state_hash text not null check (char_length(state_hash) = 64),
  source_import_id uuid not null references public.upseller_import_batches(id),
  captured_at timestamptz not null default now(),
  unique (organization_id, sku_key, warehouse_key, state_hash)
);

create table public.upseller_product_catalog (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_sku text not null,
  sku_key text not null,
  spu text,
  product_code text,
  title text,
  product_alias text,
  invoice_alias_enabled boolean,
  category text,
  variant_dimensions jsonb not null default '[]'::jsonb,
  launch_date_raw text,
  is_active boolean,
  seller text,
  retail_price numeric,
  purchase_cost numeric,
  description text,
  brand text,
  barcodes jsonb not null default '[]'::jsonb,
  sku_alias text,
  images jsonb not null default '[]'::jsonb,
  weight_g numeric,
  length_cm numeric,
  width_cm numeric,
  height_cm numeric,
  ncm text,
  cest text,
  unit text,
  origin text,
  supplier_url text,
  raw_payload jsonb not null default '{}'::jsonb,
  source_import_id uuid not null references public.upseller_import_batches(id),
  updated_at timestamptz not null default now(),
  unique (organization_id, sku_key)
);

create table public.upseller_store_aliases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  store_name text not null,
  store_name_key text not null,
  channel text not null check (channel in ('mercado_livre','shopee','kwai','temu','tiktok','unknown')),
  ml_account_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, store_name_key)
);

create trigger upseller_store_aliases_set_updated_at before update on public.upseller_store_aliases
for each row execute function private.set_updated_at();

insert into public.upseller_store_aliases (organization_id, store_name, store_name_key, channel, ml_account_code)
select organization.id, seed.store_name, seed.store_name_key, seed.channel, seed.ml_account_code
from public.organizations as organization
cross join (
  values
    ('mercado-ML- Speedbikers (loja 1)', 'MERCADO ML SPEEDBIKERS LOJA 1', 'mercado_livre', 'speedbikers'),
    ('mercado-ML- Speedbikers (loja 2)', 'MERCADO ML SPEEDBIKERS LOJA 2', 'mercado_livre', 'offracer'),
    ('mercado-ML - SbMotos', 'MERCADO ML SBMOTOS', 'mercado_livre', 'sb'),
    ('mercado-ML - GMR', 'MERCADO ML GMR', 'mercado_livre', 'gmr')
) as seed(store_name, store_name_key, channel, ml_account_code)
on conflict (organization_id, store_name_key) do update
set channel = excluded.channel, ml_account_code = excluded.ml_account_code;

create table public.upseller_channel_sku_relationships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_sku text not null,
  source_sku_key text not null,
  mapped_listing_sku text,
  mapped_listing_sku_key text,
  variant_label text,
  listing_external_id text,
  variant_external_id text,
  store_name text not null,
  store_name_key text not null,
  channel text not null check (channel in ('mercado_livre','shopee','kwai','temu','tiktok','unknown')),
  ml_account_id uuid references public.ml_accounts(id) on delete set null,
  source_updated_at_raw text,
  row_hash text not null check (char_length(row_hash) = 64),
  is_current boolean not null default true,
  source_import_id uuid not null references public.upseller_import_batches(id),
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index upseller_relationship_identity_idx
on public.upseller_channel_sku_relationships (
  organization_id, source_sku_key, mapped_listing_sku_key,
  listing_external_id, variant_external_id, store_name_key
) nulls not distinct;

create index upseller_relationship_listing_idx
on public.upseller_channel_sku_relationships (organization_id, ml_account_id, listing_external_id)
where is_current;

create trigger upseller_relationships_set_updated_at before update on public.upseller_channel_sku_relationships
for each row execute function private.set_updated_at();

create table public.upseller_kits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kit_sku text not null,
  kit_sku_key text not null,
  title text,
  alias text,
  invoice_alias_enabled boolean,
  category text,
  is_active boolean,
  image_url text,
  source_import_id uuid not null references public.upseller_import_batches(id),
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, kit_sku_key)
);

create trigger upseller_kits_set_updated_at before update on public.upseller_kits
for each row execute function private.set_updated_at();

create table public.upseller_kit_components (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kit_sku_key text not null,
  component_sku text not null,
  component_sku_key text not null,
  required_quantity integer not null check (required_quantity > 0),
  source_import_id uuid not null references public.upseller_import_batches(id),
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, kit_sku_key, component_sku_key),
  foreign key (organization_id, kit_sku_key) references public.upseller_kits(organization_id, kit_sku_key) on delete cascade
);

create trigger upseller_kit_components_set_updated_at before update on public.upseller_kit_components
for each row execute function private.set_updated_at();

create table public.product_inventory_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  product_id uuid not null,
  source text not null default 'upseller' check (source = 'upseller'),
  source_sku text not null,
  source_sku_key text not null,
  source_kind text not null check (source_kind in ('simple','kit')),
  link_method text not null check (link_method in ('exact_sku','ml_item_relationship','ml_variation_relationship','ml_user_product_relationship','manual')),
  confidence text not null check (confidence in ('exact','manual')),
  source_import_id uuid references public.upseller_import_batches(id),
  evidence jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, product_id) references public.products(organization_id, id) on delete cascade
);

create unique index product_inventory_links_one_active_idx
on public.product_inventory_links (organization_id, product_id, source)
where is_active;

create trigger product_inventory_links_set_updated_at before update on public.product_inventory_links
for each row execute function private.set_updated_at();

create table public.product_inventory_link_conflicts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  product_id uuid not null,
  source text not null default 'upseller' check (source = 'upseller'),
  candidate_source_skus jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  source_import_id uuid references public.upseller_import_batches(id),
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (organization_id, product_id) references public.products(organization_id, id) on delete cascade
);

create unique index product_inventory_link_conflicts_current_idx
on public.product_inventory_link_conflicts (organization_id, product_id, source)
where is_current;

create trigger product_inventory_link_conflicts_set_updated_at before update on public.product_inventory_link_conflicts
for each row execute function private.set_updated_at();

create table public.ml_fulfillment_stock_states (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  ml_account_id uuid not null,
  inventory_id text not null,
  total_quantity integer not null check (total_quantity >= 0),
  available_quantity integer not null check (available_quantity >= 0),
  not_available_quantity integer not null check (not_available_quantity >= 0),
  not_available_detail jsonb not null default '[]'::jsonb,
  external_references jsonb not null default '[]'::jsonb,
  state_hash text not null check (char_length(state_hash) = 64),
  checked_at timestamptz not null,
  refresh_source text not null check (refresh_source in ('backfill','notification','reconcile','manual')),
  last_operation_id text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, ml_account_id, inventory_id),
  foreign key (organization_id, ml_account_id) references public.ml_accounts(organization_id, id) on delete cascade
);

create trigger ml_fulfillment_stock_states_set_updated_at before update on public.ml_fulfillment_stock_states
for each row execute function private.set_updated_at();

create table public.ml_fulfillment_stock_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  ml_account_id uuid not null,
  inventory_id text not null,
  total_quantity integer not null,
  available_quantity integer not null,
  not_available_quantity integer not null,
  not_available_detail jsonb not null default '[]'::jsonb,
  external_references jsonb not null default '[]'::jsonb,
  state_hash text not null check (char_length(state_hash) = 64),
  refresh_source text not null,
  last_operation_id text,
  captured_at timestamptz not null default now(),
  unique (organization_id, ml_account_id, inventory_id, state_hash),
  foreign key (organization_id, ml_account_id) references public.ml_accounts(organization_id, id) on delete cascade
);

create table public.ml_fulfillment_stock_refresh_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  ml_account_id uuid not null,
  notification_key text not null unique,
  notification_id text,
  operation_id text not null,
  inventory_id text,
  seller_id text not null,
  application_id text,
  resource text not null,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','ignored')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  error_code text,
  error_message text,
  raw_body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz,
  check ((lease_id is null and lease_expires_at is null) or (lease_id is not null and lease_expires_at is not null)),
  foreign key (organization_id, ml_account_id) references public.ml_accounts(organization_id, id) on delete cascade
);

create index ml_fulfillment_refresh_jobs_queue_idx
on public.ml_fulfillment_stock_refresh_jobs (status, next_attempt_at, created_at)
where status in ('queued','running');

create trigger ml_fulfillment_refresh_jobs_set_updated_at before update on public.ml_fulfillment_stock_refresh_jobs
for each row execute function private.set_updated_at();

create table public.operational_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  product_id uuid not null,
  alert_type text not null,
  severity text not null check (severity in ('critical','warning','info')),
  status text not null default 'open' check (status in ('open','resolved')),
  dedupe_key text not null,
  evidence jsonb not null default '{}'::jsonb,
  suggested_action_code text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_evaluated_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, product_id) references public.products(organization_id, id) on delete cascade
);

create unique index operational_alerts_open_dedupe_idx
on public.operational_alerts (organization_id, dedupe_key)
where status = 'open';

create index operational_alerts_product_idx on public.operational_alerts (organization_id, product_id, status);
create trigger operational_alerts_set_updated_at before update on public.operational_alerts
for each row execute function private.set_updated_at();

create table public.operational_alert_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  product_id uuid not null,
  reason text not null,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz,
  check ((lease_id is null and lease_expires_at is null) or (lease_id is not null and lease_expires_at is not null)),
  foreign key (organization_id, product_id) references public.products(organization_id, id) on delete cascade
);

create unique index operational_alert_jobs_active_idx
on public.operational_alert_jobs (organization_id, product_id)
where status in ('queued','running');

create index operational_alert_jobs_queue_idx
on public.operational_alert_jobs (status, next_attempt_at, created_at)
where status in ('queued','running');

create trigger operational_alert_jobs_set_updated_at before update on public.operational_alert_jobs
for each row execute function private.set_updated_at();

-- RLS and least-privilege grants.
alter table public.upseller_import_batches enable row level security;
alter table public.upseller_stock_import_rows enable row level security;
alter table public.upseller_product_import_rows enable row level security;
alter table public.upseller_relationship_import_rows enable row level security;
alter table public.upseller_kit_component_import_rows enable row level security;
alter table public.upseller_stock_states enable row level security;
alter table public.upseller_stock_snapshots enable row level security;
alter table public.upseller_product_catalog enable row level security;
alter table public.upseller_store_aliases enable row level security;
alter table public.upseller_channel_sku_relationships enable row level security;
alter table public.upseller_kits enable row level security;
alter table public.upseller_kit_components enable row level security;
alter table public.product_inventory_links enable row level security;
alter table public.product_inventory_link_conflicts enable row level security;
alter table public.ml_fulfillment_stock_states enable row level security;
alter table public.ml_fulfillment_stock_snapshots enable row level security;
alter table public.ml_fulfillment_stock_refresh_jobs enable row level security;
alter table public.operational_alerts enable row level security;
alter table public.operational_alert_jobs enable row level security;

create policy upseller_import_batches_admin_select on public.upseller_import_batches
for select to authenticated using (private.has_organization_role(organization_id, array['admin'::public.app_role]));

create policy upseller_stock_states_member_select on public.upseller_stock_states
for select to authenticated using (private.is_organization_member(organization_id));
create policy upseller_stock_snapshots_member_select on public.upseller_stock_snapshots
for select to authenticated using (private.is_organization_member(organization_id));
create policy upseller_product_catalog_member_select on public.upseller_product_catalog
for select to authenticated using (private.is_organization_member(organization_id));
create policy upseller_store_aliases_member_select on public.upseller_store_aliases
for select to authenticated using (private.is_organization_member(organization_id));
create policy upseller_relationships_member_select on public.upseller_channel_sku_relationships
for select to authenticated using (private.is_organization_member(organization_id));
create policy upseller_kits_member_select on public.upseller_kits
for select to authenticated using (private.is_organization_member(organization_id));
create policy upseller_kit_components_member_select on public.upseller_kit_components
for select to authenticated using (private.is_organization_member(organization_id));
create policy product_inventory_links_member_select on public.product_inventory_links
for select to authenticated using (private.is_organization_member(organization_id));
create policy product_inventory_conflicts_member_select on public.product_inventory_link_conflicts
for select to authenticated using (private.is_organization_member(organization_id));
create policy fulfillment_states_account_select on public.ml_fulfillment_stock_states
for select to authenticated using (private.can_access_ml_account(ml_account_id));
create policy fulfillment_snapshots_account_select on public.ml_fulfillment_stock_snapshots
for select to authenticated using (private.can_access_ml_account(ml_account_id));
create policy operational_alerts_member_select on public.operational_alerts
for select to authenticated using (private.is_organization_member(organization_id));

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'upseller_import_batches','upseller_stock_import_rows','upseller_product_import_rows',
    'upseller_relationship_import_rows','upseller_kit_component_import_rows','upseller_stock_states',
    'upseller_stock_snapshots','upseller_product_catalog','upseller_store_aliases',
    'upseller_channel_sku_relationships','upseller_kits','upseller_kit_components',
    'product_inventory_links','product_inventory_link_conflicts','ml_fulfillment_stock_states',
    'ml_fulfillment_stock_snapshots','ml_fulfillment_stock_refresh_jobs','operational_alerts','operational_alert_jobs'
  ]
  loop
    execute format('revoke all on public.%I from anon', table_name);
    execute format('revoke all on public.%I from authenticated', table_name);
    execute format('grant all on public.%I to service_role', table_name);
  end loop;
end $$;

grant select on public.upseller_import_batches,
  public.upseller_stock_states, public.upseller_stock_snapshots,
  public.upseller_product_catalog, public.upseller_store_aliases,
  public.upseller_channel_sku_relationships, public.upseller_kits,
  public.upseller_kit_components, public.product_inventory_links,
  public.product_inventory_link_conflicts, public.ml_fulfillment_stock_states,
  public.ml_fulfillment_stock_snapshots, public.operational_alerts
to authenticated;
