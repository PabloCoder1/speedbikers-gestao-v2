-- Resumable UpSeller import promotion and deterministic inventory links.

alter table public.upseller_import_batches
  add column if not exists product_storage_path text,
  add column if not exists kit_storage_path text,
  add column if not exists product_file_hash text,
  add column if not exists kit_file_hash text;

alter table public.upseller_import_batches
  add constraint upseller_import_batches_product_hash_check
    check (product_file_hash is null or char_length(product_file_hash) = 64) not valid,
  add constraint upseller_import_batches_kit_hash_check
    check (kit_file_hash is null or char_length(kit_file_hash) = 64) not valid;

alter table public.upseller_import_batches
  validate constraint upseller_import_batches_product_hash_check;
alter table public.upseller_import_batches
  validate constraint upseller_import_batches_kit_hash_check;

alter table public.upseller_import_batches
  drop constraint if exists upseller_import_batches_organization_id_import_fingerprint_key;

create unique index if not exists upseller_import_batches_active_fingerprint_idx
  on public.upseller_import_batches (organization_id, import_fingerprint)
  where status not in ('failed','cancelled');

alter table public.upseller_kit_component_import_rows
  add column if not exists definition_source text not null default 'upseller_export'
    check (definition_source in ('upseller_export','derived_dot'));

alter table public.upseller_kits
  add column if not exists definition_source text not null default 'upseller_export'
    check (definition_source in ('upseller_export','derived_dot'));

alter table public.upseller_kit_components
  add column if not exists definition_source text not null default 'upseller_export'
    check (definition_source in ('upseller_export','derived_dot'));

create table public.upseller_unresolved_kits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_sku text not null,
  source_sku_key text not null,
  missing_component_sku_keys jsonb not null default '[]'::jsonb,
  reason text not null check (reason in ('invalid_dot_pattern','components_missing')),
  source_import_id uuid not null references public.upseller_import_batches(id),
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, source_sku_key)
);

create trigger upseller_unresolved_kits_set_updated_at
before update on public.upseller_unresolved_kits
for each row execute function private.set_updated_at();

create table public.upseller_inventory_link_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  import_id uuid not null references public.upseller_import_batches(id) on delete cascade,
  product_id uuid not null,
  source_sku text not null,
  source_sku_key text not null,
  source_kind text not null check (source_kind in ('simple','kit')),
  link_method text not null check (link_method in ('exact_sku','ml_item_relationship','ml_variation_relationship','ml_user_product_relationship')),
  priority integer not null check (priority > 0),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (organization_id, product_id) references public.products(organization_id, id) on delete cascade,
  foreign key (organization_id, import_id) references public.upseller_import_batches(organization_id, id) on delete cascade,
  unique (import_id, product_id, source_sku_key, link_method)
);

alter table public.upseller_unresolved_kits enable row level security;
alter table public.upseller_inventory_link_candidates enable row level security;

create policy upseller_unresolved_kits_member_select
on public.upseller_unresolved_kits for select to authenticated
using (private.is_organization_member(organization_id));

revoke all on public.upseller_unresolved_kits from public, anon, authenticated;
revoke all on public.upseller_inventory_link_candidates from public, anon, authenticated;
grant select on public.upseller_unresolved_kits to authenticated;
grant all on public.upseller_unresolved_kits to service_role;
grant all on public.upseller_inventory_link_candidates to service_role;

-- Existing primary keys already cover (import_id, row_number). These additional
-- indexes cover the composite FKs and the organization-scoped finalizers.
create index if not exists upseller_stock_import_org_import_idx
  on public.upseller_stock_import_rows (organization_id, import_id);
create index if not exists upseller_product_import_org_import_idx
  on public.upseller_product_import_rows (organization_id, import_id);
create index if not exists upseller_relationship_import_org_import_idx
  on public.upseller_relationship_import_rows (organization_id, import_id);
create index if not exists upseller_kit_import_org_import_idx
  on public.upseller_kit_component_import_rows (organization_id, import_id);

create index if not exists upseller_relationships_import_current_idx
  on public.upseller_channel_sku_relationships (organization_id, source_import_id, is_current);
create index if not exists upseller_relationships_current_variant_idx
  on public.upseller_channel_sku_relationships
    (organization_id, ml_account_id, listing_external_id, variant_external_id)
  where is_current and channel = 'mercado_livre';
create index if not exists upseller_relationships_current_store_sku_idx
  on public.upseller_channel_sku_relationships (organization_id, store_name_key, source_sku_key)
  where is_current;

create index if not exists upseller_link_candidates_promotion_idx
  on public.upseller_inventory_link_candidates (import_id, organization_id, product_id, priority);
create index if not exists product_inventory_links_manual_idx
  on public.product_inventory_links (organization_id, product_id, source, link_method)
  where is_active;

-- Old failed batches, including historical monolithic promotions, remain failed.
-- Only live legacy batches are translated to the first resumable promotion phase.
update public.upseller_import_batches
set phase = 'promote_catalog', cursor_row = 0
where phase = 'promote' and status in ('queued','running');

create or replace function public.promote_upseller_import_chunk(
  target_import_id uuid,
  requested_lease_id uuid,
  chunk_size integer default 1500
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  batch public.upseller_import_batches%rowtype;
  current_phase text;
  last_row integer;
  processed integer;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'not_authorized'; end if;
  if requested_lease_id is null then raise exception 'lease_id_required'; end if;
  if chunk_size < 100 or chunk_size > 3000 then raise exception 'invalid_chunk_size'; end if;

  select * into batch
  from public.upseller_import_batches
  where id = target_import_id and lease_id = requested_lease_id
  for update;

  if batch.id is null then raise exception 'import_or_lease_not_found'; end if;
  if batch.status <> 'running' then raise exception 'invalid_import_status'; end if;
  if jsonb_array_length(coalesce(batch.validation_issues -> 'blockingIssues', '[]'::jsonb)) > 0 then
    raise exception 'import_has_blocking_issues';
  end if;

  current_phase := case when batch.phase = 'promote' then 'promote_catalog' else batch.phase end;

  if current_phase = 'promote_catalog' then
    if batch.cursor_row = 0 then
      if (select count(*) from public.upseller_stock_import_rows where import_id = batch.id)
          <> coalesce((batch.preview_summary ->> 'stockRows')::integer, 0)
        or (select count(*) from public.upseller_product_import_rows where import_id = batch.id)
          <> coalesce((batch.preview_summary ->> 'productRows')::integer, 0)
        or (select count(*) from public.upseller_relationship_import_rows where import_id = batch.id)
          <> coalesce((batch.preview_summary ->> 'relationshipRows')::integer, 0)
        or (select count(*) from public.upseller_kit_component_import_rows where import_id = batch.id)
          <> coalesce((batch.preview_summary ->> 'kitRows')::integer, 0)
      then
        raise exception 'staging_count_mismatch';
      end if;
    end if;

    with selected as (
      select * from public.upseller_product_import_rows
      where import_id = batch.id and row_number > batch.cursor_row
      order by row_number limit chunk_size
    )
    insert into public.upseller_product_catalog (
      organization_id, source_sku, sku_key, spu, product_code, title, product_alias,
      invoice_alias_enabled, category, variant_dimensions, launch_date_raw, is_active,
      seller, retail_price, purchase_cost, description, brand, barcodes, sku_alias,
      images, weight_g, length_cm, width_cm, height_cm, ncm, cest, unit, origin,
      supplier_url, raw_payload, source_import_id, updated_at
    )
    select organization_id, source_sku, sku_key, spu, product_code, title, product_alias,
      invoice_alias_enabled, category, variant_dimensions, launch_date_raw, is_active,
      seller, retail_price, purchase_cost, description, brand, barcodes, sku_alias,
      images, weight_g, length_cm, width_cm, height_cm, ncm, cest, unit, origin,
      supplier_url, raw_payload, import_id, now()
    from selected
    on conflict (organization_id, sku_key) do update set
      source_sku = excluded.source_sku, spu = excluded.spu, product_code = excluded.product_code,
      title = excluded.title, product_alias = excluded.product_alias,
      invoice_alias_enabled = excluded.invoice_alias_enabled, category = excluded.category,
      variant_dimensions = excluded.variant_dimensions, launch_date_raw = excluded.launch_date_raw,
      is_active = excluded.is_active, seller = excluded.seller, retail_price = excluded.retail_price,
      purchase_cost = excluded.purchase_cost, description = excluded.description,
      brand = excluded.brand, barcodes = excluded.barcodes, sku_alias = excluded.sku_alias,
      images = excluded.images, weight_g = excluded.weight_g, length_cm = excluded.length_cm,
      width_cm = excluded.width_cm, height_cm = excluded.height_cm, ncm = excluded.ncm,
      cest = excluded.cest, unit = excluded.unit, origin = excluded.origin,
      supplier_url = excluded.supplier_url, raw_payload = excluded.raw_payload,
      source_import_id = excluded.source_import_id, updated_at = now();

    select coalesce(max(row_number), batch.cursor_row) into last_row
    from (select row_number from public.upseller_product_import_rows
      where import_id = batch.id and row_number > batch.cursor_row order by row_number limit chunk_size) selected;

    if not exists (select 1 from public.upseller_product_import_rows where import_id = batch.id and row_number > last_row) then
      delete from public.upseller_product_catalog catalog
      where catalog.organization_id = batch.organization_id
        and not exists (select 1 from public.upseller_product_import_rows staging
          where staging.import_id = batch.id and staging.sku_key = catalog.sku_key);
      update public.upseller_import_batches set status = 'queued', phase = 'promote_stock', cursor_row = 0,
        attempt_count = 0, next_attempt_at = now(), lease_id = null, lease_expires_at = null,
        error_code = null, error_message = null where id = batch.id;
      return jsonb_build_object('completed', false, 'phase', 'promote_stock', 'cursorRow', 0);
    end if;

  elsif current_phase = 'promote_stock' then
    with selected as (
      select * from public.upseller_stock_import_rows
      where import_id = batch.id and row_number > batch.cursor_row
      order by row_number limit chunk_size
    )
    insert into public.upseller_stock_snapshots (
      organization_id, source_sku, sku_key, warehouse_name, warehouse_key,
      low_stock_threshold, purchase_in_transit, transfer_in_transit, occupied_quantity,
      available_quantity, current_quantity, average_cost, stock_value, state_hash, source_import_id
    )
    select organization_id, source_sku, sku_key, warehouse_name, warehouse_key,
      low_stock_threshold, purchase_in_transit, transfer_in_transit, occupied_quantity,
      available_quantity, current_quantity, average_cost, stock_value, state_hash, import_id
    from selected on conflict (organization_id, sku_key, warehouse_key, state_hash) do nothing;

    with selected as (
      select * from public.upseller_stock_import_rows
      where import_id = batch.id and row_number > batch.cursor_row
      order by row_number limit chunk_size
    )
    insert into public.upseller_stock_states (
      organization_id, source_sku, sku_key, title, warehouse_name, warehouse_key, shelf,
      low_stock_threshold, purchase_in_transit, transfer_in_transit, occupied_quantity,
      available_quantity, current_quantity, average_cost, stock_value, source_created_at_raw,
      state_hash, source_import_id, checked_at
    )
    select organization_id, source_sku, sku_key, title, warehouse_name, warehouse_key, shelf,
      low_stock_threshold, purchase_in_transit, transfer_in_transit, occupied_quantity,
      available_quantity, current_quantity, average_cost, stock_value, source_created_at_raw,
      state_hash, import_id, now() from selected
    on conflict (organization_id, sku_key, warehouse_key) do update set
      source_sku = excluded.source_sku, title = excluded.title, warehouse_name = excluded.warehouse_name,
      shelf = excluded.shelf, low_stock_threshold = excluded.low_stock_threshold,
      purchase_in_transit = excluded.purchase_in_transit, transfer_in_transit = excluded.transfer_in_transit,
      occupied_quantity = excluded.occupied_quantity, available_quantity = excluded.available_quantity,
      current_quantity = excluded.current_quantity, average_cost = excluded.average_cost,
      stock_value = excluded.stock_value, source_created_at_raw = excluded.source_created_at_raw,
      state_hash = excluded.state_hash, source_import_id = excluded.source_import_id, checked_at = excluded.checked_at;

    select coalesce(max(row_number), batch.cursor_row) into last_row
    from (select row_number from public.upseller_stock_import_rows
      where import_id = batch.id and row_number > batch.cursor_row order by row_number limit chunk_size) selected;
    if not exists (select 1 from public.upseller_stock_import_rows where import_id = batch.id and row_number > last_row) then
      delete from public.upseller_stock_states state
      where state.organization_id = batch.organization_id
        and not exists (select 1 from public.upseller_stock_import_rows staging
          where staging.import_id = batch.id and staging.sku_key = state.sku_key
            and staging.warehouse_key = state.warehouse_key);
      update public.upseller_import_batches set status = 'queued', phase = 'promote_relationships', cursor_row = 0,
        attempt_count = 0, next_attempt_at = now(), lease_id = null, lease_expires_at = null,
        error_code = null, error_message = null where id = batch.id;
      return jsonb_build_object('completed', false, 'phase', 'promote_relationships', 'cursorRow', 0);
    end if;

  elsif current_phase = 'promote_relationships' then
    insert into public.upseller_store_aliases (organization_id, store_name, store_name_key, channel, ml_account_code)
    values
      (batch.organization_id, 'mercado-ML- Speedbikers (loja 1)', 'MERCADO ML SPEEDBIKERS LOJA 1', 'mercado_livre', 'speedbikers'),
      (batch.organization_id, 'mercado-ML- Speedbikers (loja 2)', 'MERCADO ML SPEEDBIKERS LOJA 2', 'mercado_livre', 'offracer'),
      (batch.organization_id, 'mercado-ML - SbMotos', 'MERCADO ML SBMOTOS', 'mercado_livre', 'sb'),
      (batch.organization_id, 'mercado-ML - GMR', 'MERCADO ML GMR', 'mercado_livre', 'gmr')
    on conflict (organization_id, store_name_key) do update set
      channel = excluded.channel, ml_account_code = excluded.ml_account_code;

    with selected as (
      select * from public.upseller_relationship_import_rows
      where import_id = batch.id and row_number > batch.cursor_row
      order by row_number limit chunk_size
    )
    insert into public.upseller_channel_sku_relationships (
      organization_id, source_sku, source_sku_key, mapped_listing_sku,
      mapped_listing_sku_key, variant_label, listing_external_id, variant_external_id,
      store_name, store_name_key, channel, ml_account_id, source_updated_at_raw,
      row_hash, is_current, source_import_id, raw_payload
    )
    select staging.organization_id, staging.source_sku, staging.source_sku_key,
      staging.mapped_listing_sku, staging.mapped_listing_sku_key, staging.variant_label,
      staging.listing_external_id, staging.variant_external_id, staging.store_name,
      staging.store_name_key, staging.channel, account.id, staging.source_updated_at_raw,
      staging.row_hash, true, staging.import_id, staging.raw_payload
    from selected staging
    left join public.upseller_store_aliases alias
      on alias.organization_id = staging.organization_id and alias.store_name_key = staging.store_name_key
    left join public.ml_accounts account
      on account.organization_id = staging.organization_id and account.code = alias.ml_account_code
    on conflict (organization_id, source_sku_key, mapped_listing_sku_key,
      listing_external_id, variant_external_id, store_name_key) do update set
      source_sku = excluded.source_sku, mapped_listing_sku = excluded.mapped_listing_sku,
      variant_label = excluded.variant_label, store_name = excluded.store_name,
      channel = excluded.channel, ml_account_id = excluded.ml_account_id,
      source_updated_at_raw = excluded.source_updated_at_raw, row_hash = excluded.row_hash,
      is_current = true, source_import_id = excluded.source_import_id, raw_payload = excluded.raw_payload;

    select coalesce(max(row_number), batch.cursor_row) into last_row
    from (select row_number from public.upseller_relationship_import_rows
      where import_id = batch.id and row_number > batch.cursor_row order by row_number limit chunk_size) selected;
    if not exists (select 1 from public.upseller_relationship_import_rows where import_id = batch.id and row_number > last_row) then
      update public.upseller_channel_sku_relationships set is_current = false
      where organization_id = batch.organization_id and is_current and source_import_id <> batch.id;
      update public.upseller_import_batches set status = 'queued', phase = 'promote_kits', cursor_row = 0,
        attempt_count = 0, next_attempt_at = now(), lease_id = null, lease_expires_at = null,
        error_code = null, error_message = null where id = batch.id;
      return jsonb_build_object('completed', false, 'phase', 'promote_kits', 'cursorRow', 0);
    end if;

  elsif current_phase = 'promote_kits' then
    with selected as (
      select * from public.upseller_kit_component_import_rows
      where import_id = batch.id and row_number > batch.cursor_row
      order by row_number limit chunk_size
    )
    insert into public.upseller_kits (
      organization_id, kit_sku, kit_sku_key, title, alias, invoice_alias_enabled,
      category, is_active, image_url, definition_source, source_import_id, is_current
    )
    select distinct on (organization_id, kit_sku_key)
      organization_id, kit_sku, kit_sku_key, title, alias, invoice_alias_enabled,
      category, is_active, image_url, 'upseller_export', import_id, true
    from selected order by organization_id, kit_sku_key, row_number
    on conflict (organization_id, kit_sku_key) do update set
      kit_sku = excluded.kit_sku, title = excluded.title, alias = excluded.alias,
      invoice_alias_enabled = excluded.invoice_alias_enabled, category = excluded.category,
      is_active = excluded.is_active, image_url = excluded.image_url,
      definition_source = 'upseller_export', source_import_id = excluded.source_import_id, is_current = true;

    with selected as (
      select * from public.upseller_kit_component_import_rows
      where import_id = batch.id and row_number > batch.cursor_row
      order by row_number limit chunk_size
    )
    insert into public.upseller_kit_components (
      organization_id, kit_sku_key, component_sku, component_sku_key,
      required_quantity, definition_source, source_import_id, is_current
    )
    select organization_id, kit_sku_key, component_sku, component_sku_key,
      required_quantity, 'upseller_export', import_id, true from selected
    on conflict (organization_id, kit_sku_key, component_sku_key) do update set
      component_sku = excluded.component_sku, required_quantity = excluded.required_quantity,
      definition_source = 'upseller_export', source_import_id = excluded.source_import_id, is_current = true;

    select coalesce(max(row_number), batch.cursor_row) into last_row
    from (select row_number from public.upseller_kit_component_import_rows
      where import_id = batch.id and row_number > batch.cursor_row order by row_number limit chunk_size) selected;
    if not exists (select 1 from public.upseller_kit_component_import_rows where import_id = batch.id and row_number > last_row) then
      update public.upseller_import_batches set status = 'queued', phase = 'derive_kits', cursor_row = 0,
        attempt_count = 0, next_attempt_at = now(), lease_id = null, lease_expires_at = null,
        error_code = null, error_message = null where id = batch.id;
      return jsonb_build_object('completed', false, 'phase', 'derive_kits', 'cursorRow', 0);
    end if;

  elsif current_phase = 'derive_kits' then
    with dotted as (
      select product.*,
        product.sku_key ~ '^[^.]+(\.[^.]+)+$' as valid_pattern,
        array(select distinct btrim(part) from unnest(string_to_array(product.sku_key, '.')) part
          where btrim(part) <> '' and not exists (
            select 1 from public.upseller_product_import_rows component
            where component.import_id = batch.id and component.sku_key = btrim(part)
            union all
            select 1 from public.upseller_stock_import_rows stock
            where stock.import_id = batch.id and stock.sku_key = btrim(part)
          )) as missing_parts
      from public.upseller_product_import_rows product
      where product.import_id = batch.id and position('.' in product.source_sku) > 0
        and not exists (select 1 from public.upseller_kit_component_import_rows explicit
          where explicit.import_id = batch.id and explicit.kit_sku_key = product.sku_key)
    )
    insert into public.upseller_kits (
      organization_id, kit_sku, kit_sku_key, title, alias, invoice_alias_enabled,
      category, is_active, image_url, definition_source, source_import_id, is_current
    )
    select organization_id, source_sku, sku_key, title, product_alias, invoice_alias_enabled,
      category, is_active, null, 'derived_dot', import_id, true
    from dotted where valid_pattern and cardinality(missing_parts) = 0
    on conflict (organization_id, kit_sku_key) do update set
      kit_sku = excluded.kit_sku, title = excluded.title, alias = excluded.alias,
      invoice_alias_enabled = excluded.invoice_alias_enabled, category = excluded.category,
      is_active = excluded.is_active, image_url = excluded.image_url,
      definition_source = excluded.definition_source, source_import_id = excluded.source_import_id, is_current = true;

    with dotted as (
      select product.*
      from public.upseller_product_import_rows product
      where product.import_id = batch.id and product.sku_key ~ '^[^.]+(\.[^.]+)+$'
        and not exists (select 1 from public.upseller_kit_component_import_rows explicit
          where explicit.import_id = batch.id and explicit.kit_sku_key = product.sku_key)
        and not exists (
          select 1 from unnest(string_to_array(product.sku_key, '.')) part
          where not exists (
            select 1 from public.upseller_product_import_rows component
            where component.import_id = batch.id and component.sku_key = btrim(part)
            union all
            select 1 from public.upseller_stock_import_rows stock
            where stock.import_id = batch.id and stock.sku_key = btrim(part)
          )
        )
    ), components as (
      select dotted.organization_id, dotted.sku_key as kit_sku_key,
        btrim(part) as component_sku_key, count(*)::integer as required_quantity,
        dotted.import_id
      from dotted cross join lateral unnest(string_to_array(dotted.sku_key, '.')) part
      group by dotted.organization_id, dotted.sku_key, btrim(part), dotted.import_id
    )
    insert into public.upseller_kit_components (
      organization_id, kit_sku_key, component_sku, component_sku_key,
      required_quantity, definition_source, source_import_id, is_current
    )
    select organization_id, kit_sku_key, component_sku_key, component_sku_key,
      required_quantity, 'derived_dot', import_id, true from components
    on conflict (organization_id, kit_sku_key, component_sku_key) do update set
      component_sku = excluded.component_sku, required_quantity = excluded.required_quantity,
      definition_source = excluded.definition_source, source_import_id = excluded.source_import_id, is_current = true;

    with dotted as (
      select product.*,
        product.sku_key ~ '^[^.]+(\.[^.]+)+$' as valid_pattern,
        array(select distinct btrim(part) from unnest(string_to_array(product.sku_key, '.')) part
          where btrim(part) <> '' and not exists (
            select 1 from public.upseller_product_import_rows component
            where component.import_id = batch.id and component.sku_key = btrim(part)
            union all
            select 1 from public.upseller_stock_import_rows stock
            where stock.import_id = batch.id and stock.sku_key = btrim(part)
          )) as missing_parts
      from public.upseller_product_import_rows product
      where product.import_id = batch.id and position('.' in product.source_sku) > 0
        and not exists (select 1 from public.upseller_kit_component_import_rows explicit
          where explicit.import_id = batch.id and explicit.kit_sku_key = product.sku_key)
    )
    insert into public.upseller_unresolved_kits (
      organization_id, source_sku, source_sku_key, missing_component_sku_keys,
      reason, source_import_id, is_current
    )
    select organization_id, source_sku, sku_key, to_jsonb(missing_parts),
      case when valid_pattern then 'components_missing' else 'invalid_dot_pattern' end,
      import_id, true from dotted where not valid_pattern or cardinality(missing_parts) > 0
    on conflict (organization_id, source_sku_key) do update set
      source_sku = excluded.source_sku,
      missing_component_sku_keys = excluded.missing_component_sku_keys,
      reason = excluded.reason, source_import_id = excluded.source_import_id, is_current = true;

    update public.upseller_kit_components set is_current = false
    where organization_id = batch.organization_id and is_current and source_import_id <> batch.id;
    update public.upseller_kits set is_current = false
    where organization_id = batch.organization_id and is_current and source_import_id <> batch.id;
    update public.upseller_unresolved_kits set is_current = false
    where organization_id = batch.organization_id and is_current and source_import_id <> batch.id;

    update public.upseller_import_batches set status = 'queued', phase = 'build_links_exact', cursor_row = 0,
      attempt_count = 0, next_attempt_at = now(), lease_id = null, lease_expires_at = null,
      error_code = null, error_message = null where id = batch.id;
    return jsonb_build_object('completed', false, 'phase', 'build_links_exact', 'cursorRow', 0);

  elsif current_phase = 'build_links_exact' then
    select count(*) into processed from (
      select id from public.products where organization_id = batch.organization_id
      order by id offset batch.cursor_row limit chunk_size
    ) selected;
    with selected as (
      select * from public.products where organization_id = batch.organization_id
      order by id offset batch.cursor_row limit chunk_size
    )
    insert into public.upseller_inventory_link_candidates (
      organization_id, import_id, product_id, source_sku, source_sku_key,
      source_kind, link_method, priority, evidence
    )
    select batch.organization_id, batch.id, product.id,
      coalesce(kit.kit_sku, catalog.source_sku, stock.source_sku, product.sku), product.sku_key,
      case when kit.kit_sku_key is not null then 'kit' else 'simple' end,
      'exact_sku', 1, jsonb_build_object('canonicalSku', product.sku)
    from selected product
    left join public.upseller_kits kit on kit.organization_id = product.organization_id
      and kit.kit_sku_key = product.sku_key and kit.is_current
    left join public.upseller_product_catalog catalog on catalog.organization_id = product.organization_id
      and catalog.sku_key = product.sku_key
    left join lateral (select state.source_sku from public.upseller_stock_states state
      where state.organization_id = product.organization_id and state.sku_key = product.sku_key limit 1) stock on true
    where (kit.kit_sku_key is not null or catalog.sku_key is not null or stock.source_sku is not null)
      and not exists (select 1 from public.upseller_unresolved_kits unresolved
        where unresolved.organization_id = product.organization_id
          and unresolved.source_sku_key = product.sku_key and unresolved.is_current)
    on conflict (import_id, product_id, source_sku_key, link_method) do update set
      source_sku = excluded.source_sku, source_kind = excluded.source_kind,
      priority = excluded.priority, evidence = excluded.evidence;

    if processed < chunk_size then
      update public.upseller_import_batches set status = 'queued', phase = 'build_links_item', cursor_row = 0,
        attempt_count = 0, next_attempt_at = now(), lease_id = null, lease_expires_at = null,
        error_code = null, error_message = null where id = batch.id;
      return jsonb_build_object('completed', false, 'phase', 'build_links_item', 'cursorRow', 0);
    end if;
    last_row := batch.cursor_row + processed;

  elsif current_phase in ('build_links_item','build_links_variation','build_links_user_product') then
    select count(*), coalesce(max(row_number), batch.cursor_row) into processed, last_row
    from (select row_number from public.upseller_relationship_import_rows
      where import_id = batch.id and row_number > batch.cursor_row order by row_number limit chunk_size) selected;

    if current_phase = 'build_links_item' then
      with selected as (
        select * from public.upseller_relationship_import_rows
        where import_id = batch.id and row_number > batch.cursor_row order by row_number limit chunk_size
      )
      insert into public.upseller_inventory_link_candidates (
        organization_id, import_id, product_id, source_sku, source_sku_key,
        source_kind, link_method, priority, evidence
      )
      select batch.organization_id, batch.id, listing.product_id, relation.source_sku, relation.source_sku_key,
        case when kit.kit_sku_key is not null then 'kit' else 'simple' end,
        'ml_item_relationship', 2,
        jsonb_build_object('itemId', listing.item_id, 'storeName', relation.store_name, 'mlAccountId', listing.ml_account_id)
      from selected relation
      join public.upseller_store_aliases alias on alias.organization_id = relation.organization_id
        and alias.store_name_key = relation.store_name_key
      join public.ml_accounts account on account.organization_id = relation.organization_id
        and account.code = alias.ml_account_code
      join public.ml_listings listing on listing.organization_id = relation.organization_id
        and listing.ml_account_id = account.id and listing.item_id = relation.listing_external_id
        and listing.is_current and listing.product_id is not null
      left join public.upseller_kits kit on kit.organization_id = relation.organization_id
        and kit.kit_sku_key = relation.source_sku_key and kit.is_current
      where relation.channel = 'mercado_livre'
        and not exists (select 1 from public.upseller_unresolved_kits unresolved
          where unresolved.organization_id = relation.organization_id
            and unresolved.source_sku_key = relation.source_sku_key and unresolved.is_current)
      on conflict (import_id, product_id, source_sku_key, link_method) do update set
        source_sku = excluded.source_sku, source_kind = excluded.source_kind,
        priority = excluded.priority, evidence = excluded.evidence;

    elsif current_phase = 'build_links_variation' then
      with selected as (
        select * from public.upseller_relationship_import_rows
        where import_id = batch.id and row_number > batch.cursor_row order by row_number limit chunk_size
      )
      insert into public.upseller_inventory_link_candidates (
        organization_id, import_id, product_id, source_sku, source_sku_key,
        source_kind, link_method, priority, evidence
      )
      select batch.organization_id, batch.id, variation.product_id, relation.source_sku, relation.source_sku_key,
        case when kit.kit_sku_key is not null then 'kit' else 'simple' end,
        'ml_variation_relationship', 3,
        jsonb_build_object('itemId', listing.item_id, 'variationId', variation.variation_id, 'storeName', relation.store_name)
      from selected relation
      join public.upseller_store_aliases alias on alias.organization_id = relation.organization_id
        and alias.store_name_key = relation.store_name_key
      join public.ml_accounts account on account.organization_id = relation.organization_id
        and account.code = alias.ml_account_code
      join public.ml_listings listing on listing.organization_id = relation.organization_id
        and listing.ml_account_id = account.id and listing.item_id = relation.listing_external_id and listing.is_current
      join public.ml_listing_variations variation on variation.ml_listing_id = listing.id
        and variation.variation_id = relation.variant_external_id and variation.is_current
        and variation.product_id is not null
      left join public.upseller_kits kit on kit.organization_id = relation.organization_id
        and kit.kit_sku_key = relation.source_sku_key and kit.is_current
      where relation.channel = 'mercado_livre'
        and not exists (select 1 from public.upseller_unresolved_kits unresolved
          where unresolved.organization_id = relation.organization_id
            and unresolved.source_sku_key = relation.source_sku_key and unresolved.is_current)
      on conflict (import_id, product_id, source_sku_key, link_method) do update set
        source_sku = excluded.source_sku, source_kind = excluded.source_kind,
        priority = excluded.priority, evidence = excluded.evidence;

    else
      with selected as (
        select * from public.upseller_relationship_import_rows
        where import_id = batch.id and row_number > batch.cursor_row order by row_number limit chunk_size
      ), targets as (
        select organization_id, ml_account_id, product_id, user_product_id from public.ml_listings
        where is_current and product_id is not null and user_product_id is not null
        union all
        select organization_id, ml_account_id, product_id, user_product_id from public.ml_listing_variations
        where is_current and product_id is not null and user_product_id is not null
      )
      insert into public.upseller_inventory_link_candidates (
        organization_id, import_id, product_id, source_sku, source_sku_key,
        source_kind, link_method, priority, evidence
      )
      select batch.organization_id, batch.id, target.product_id, relation.source_sku, relation.source_sku_key,
        case when kit.kit_sku_key is not null then 'kit' else 'simple' end,
        'ml_user_product_relationship', 4,
        jsonb_build_object('userProductId', relation.listing_external_id, 'storeName', relation.store_name)
      from selected relation
      join public.upseller_store_aliases alias on alias.organization_id = relation.organization_id
        and alias.store_name_key = relation.store_name_key
      join public.ml_accounts account on account.organization_id = relation.organization_id
        and account.code = alias.ml_account_code
      join targets target on target.organization_id = relation.organization_id
        and target.ml_account_id = account.id and target.user_product_id = relation.listing_external_id
      left join public.upseller_kits kit on kit.organization_id = relation.organization_id
        and kit.kit_sku_key = relation.source_sku_key and kit.is_current
      where relation.channel = 'mercado_livre' and relation.listing_external_id like 'MLBU%'
        and not exists (select 1 from public.upseller_unresolved_kits unresolved
          where unresolved.organization_id = relation.organization_id
            and unresolved.source_sku_key = relation.source_sku_key and unresolved.is_current)
      on conflict (import_id, product_id, source_sku_key, link_method) do update set
        source_sku = excluded.source_sku, source_kind = excluded.source_kind,
        priority = excluded.priority, evidence = excluded.evidence;
    end if;

    if processed < chunk_size then
      update public.upseller_import_batches set status = 'queued',
        phase = case current_phase when 'build_links_item' then 'build_links_variation'
          when 'build_links_variation' then 'build_links_user_product' else 'promote_links' end,
        cursor_row = 0, attempt_count = 0, next_attempt_at = now(),
        lease_id = null, lease_expires_at = null, error_code = null, error_message = null
      where id = batch.id;
      return jsonb_build_object('completed', false,
        'phase', case current_phase when 'build_links_item' then 'build_links_variation'
          when 'build_links_variation' then 'build_links_user_product' else 'promote_links' end,
        'cursorRow', 0);
    end if;

  elsif current_phase = 'promote_links' then
    select count(*) into processed from (
      select id from public.products where organization_id = batch.organization_id
      order by id offset batch.cursor_row limit chunk_size
    ) selected;

    with selected as (
      select id from public.products where organization_id = batch.organization_id
      order by id offset batch.cursor_row limit chunk_size
    )
    update public.product_inventory_link_conflicts conflict
    set is_current = false, resolved_at = now()
    where conflict.organization_id = batch.organization_id and conflict.source = 'upseller'
      and conflict.is_current and conflict.product_id in (select id from selected);

    with selected as (
      select id from public.products where organization_id = batch.organization_id
      order by id offset batch.cursor_row limit chunk_size
    ), conflicts as (
      select candidate.product_id,
        jsonb_agg(distinct candidate.source_sku_key order by candidate.source_sku_key) as source_skus,
        jsonb_agg(distinct candidate.link_method order by candidate.link_method) as methods
      from public.upseller_inventory_link_candidates candidate
      where candidate.import_id = batch.id and candidate.product_id in (select id from selected)
        and not exists (select 1 from public.product_inventory_links manual
          where manual.organization_id = batch.organization_id and manual.product_id = candidate.product_id
            and manual.source = 'upseller' and manual.link_method = 'manual' and manual.is_active)
      group by candidate.product_id having count(distinct candidate.source_sku_key) > 1
    )
    insert into public.product_inventory_link_conflicts (
      organization_id, product_id, source, candidate_source_skus,
      evidence, source_import_id, is_current
    )
    select batch.organization_id, conflicts.product_id, 'upseller', conflicts.source_skus,
      jsonb_build_object('methods', conflicts.methods), batch.id, true from conflicts
    on conflict (organization_id, product_id, source) where is_current do update set
      candidate_source_skus = excluded.candidate_source_skus, evidence = excluded.evidence,
      source_import_id = excluded.source_import_id, resolved_at = null;

    with selected as (
      select id from public.products where organization_id = batch.organization_id
      order by id offset batch.cursor_row limit chunk_size
    )
    update public.product_inventory_links link set is_active = false
    where link.organization_id = batch.organization_id and link.source = 'upseller'
      and link.is_active and link.link_method <> 'manual' and link.product_id in (select id from selected);

    with selected as (
      select id from public.products where organization_id = batch.organization_id
      order by id offset batch.cursor_row limit chunk_size
    ), chosen as (
      select distinct on (candidate.product_id) candidate.*
      from public.upseller_inventory_link_candidates candidate
      where candidate.import_id = batch.id and candidate.product_id in (select id from selected)
        and not exists (select 1 from public.product_inventory_link_conflicts conflict
          where conflict.organization_id = batch.organization_id and conflict.product_id = candidate.product_id
            and conflict.source = 'upseller' and conflict.is_current)
        and not exists (select 1 from public.product_inventory_links manual
          where manual.organization_id = batch.organization_id and manual.product_id = candidate.product_id
            and manual.source = 'upseller' and manual.link_method = 'manual' and manual.is_active)
      order by candidate.product_id, candidate.priority, candidate.source_sku_key, candidate.link_method
    )
    insert into public.product_inventory_links (
      organization_id, product_id, source, source_sku, source_sku_key, source_kind,
      link_method, confidence, source_import_id, evidence, is_active
    )
    select batch.organization_id, chosen.product_id, 'upseller', chosen.source_sku,
      chosen.source_sku_key, chosen.source_kind, chosen.link_method, 'exact', batch.id,
      chosen.evidence, true from chosen
    on conflict (organization_id, product_id, source) where is_active do update set
      source_sku = excluded.source_sku, source_sku_key = excluded.source_sku_key,
      source_kind = excluded.source_kind, link_method = excluded.link_method,
      confidence = excluded.confidence, source_import_id = excluded.source_import_id,
      evidence = excluded.evidence, updated_at = now();

    if processed < chunk_size then
      update public.upseller_import_batches set status = 'queued', phase = 'finalize', cursor_row = 0,
        attempt_count = 0, next_attempt_at = now(), lease_id = null, lease_expires_at = null,
        error_code = null, error_message = null where id = batch.id;
      return jsonb_build_object('completed', false, 'phase', 'finalize', 'cursorRow', 0);
    end if;
    last_row := batch.cursor_row + processed;

  elsif current_phase = 'finalize' then
    update public.upseller_import_batches
    set status = 'applied', phase = 'applied', cursor_row = 0, attempt_count = 0,
      lease_id = null, lease_expires_at = null, error_code = null, error_message = null,
      applied_at = now() where id = batch.id;

    insert into public.operational_alert_jobs (organization_id, product_id, reason)
    select product.organization_id, product.id, 'upseller_import'
    from public.products product where product.organization_id = batch.organization_id
    on conflict (organization_id, product_id) where status in ('queued','running') do nothing;

    return jsonb_build_object('completed', true, 'phase', 'applied', 'cursorRow', 0);
  else
    raise exception 'invalid_promotion_phase:%', current_phase;
  end if;

  update public.upseller_import_batches
  set status = 'queued', phase = current_phase, cursor_row = last_row,
    attempt_count = 0, next_attempt_at = now(), lease_id = null, lease_expires_at = null,
    error_code = null, error_message = null where id = batch.id;
  return jsonb_build_object('completed', false, 'phase', current_phase, 'cursorRow', last_row);
end;
$$;

revoke all on function public.promote_upseller_import_chunk(uuid, uuid, integer)
from public, anon, authenticated;
grant execute on function public.promote_upseller_import_chunk(uuid, uuid, integer) to service_role;

-- The legacy monolithic function is removed by the follow-up migration after
-- the resumable RPC and worker contract are both present.
