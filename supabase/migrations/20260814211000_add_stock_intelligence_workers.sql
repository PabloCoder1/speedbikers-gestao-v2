-- Speed Bikers Gestão V2 — atomic promotion, queues and schedulers.

create unique index sync_runs_one_active_fulfillment_backfill_idx
on public.sync_runs (ml_account_id)
where sync_type = 'fulfillment_stock_backfill' and status in ('queued','running');

create or replace function public.claim_next_upseller_import(
  requested_lease_id uuid,
  lease_duration_seconds integer default 120
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare claimed_id uuid;
begin
  if requested_lease_id is null then raise exception 'lease_id_required'; end if;
  if lease_duration_seconds < 30 or lease_duration_seconds > 300 then raise exception 'invalid_lease_duration'; end if;

  with candidate as (
    select batch.id
    from public.upseller_import_batches as batch
    where batch.status in ('queued','running')
      and batch.next_attempt_at <= now()
      and (batch.lease_id is null or batch.lease_expires_at <= now())
    order by batch.next_attempt_at, batch.created_at
    for update skip locked
    limit 1
  )
  update public.upseller_import_batches as batch
  set status = 'running',
      lease_id = requested_lease_id,
      lease_expires_at = now() + make_interval(secs => lease_duration_seconds)
  from candidate
  where batch.id = candidate.id
  returning batch.id into claimed_id;

  return claimed_id;
end;
$$;

create or replace function public.promote_upseller_import(target_import_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  batch public.upseller_import_batches%rowtype;
  expected_stock integer;
  expected_products integer;
  expected_relationships integer;
  expected_kits integer;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'not_authorized'; end if;

  select * into batch
  from public.upseller_import_batches
  where id = target_import_id
  for update;

  if batch.id is null then raise exception 'import_not_found'; end if;
  if batch.status not in ('queued','running') then raise exception 'invalid_import_status'; end if;
  if jsonb_array_length(coalesce(batch.validation_issues -> 'blockingIssues', '[]'::jsonb)) > 0 then
    raise exception 'import_has_blocking_issues';
  end if;

  expected_stock := coalesce((batch.preview_summary ->> 'stockRows')::integer, 0);
  expected_products := coalesce((batch.preview_summary ->> 'productRows')::integer, 0);
  expected_relationships := coalesce((batch.preview_summary ->> 'relationshipRows')::integer, 0);
  expected_kits := coalesce((batch.preview_summary ->> 'kitRows')::integer, 0);

  if (select count(*) from public.upseller_stock_import_rows where import_id = batch.id) <> expected_stock
    or (select count(*) from public.upseller_product_import_rows where import_id = batch.id) <> expected_products
    or (select count(*) from public.upseller_relationship_import_rows where import_id = batch.id) <> expected_relationships
    or (select count(*) from public.upseller_kit_component_import_rows where import_id = batch.id) <> expected_kits
  then
    raise exception 'staging_count_mismatch';
  end if;

  delete from public.upseller_product_catalog as catalog
  where catalog.organization_id = batch.organization_id
    and not exists (
      select 1 from public.upseller_product_import_rows as staging
      where staging.import_id = batch.id and staging.sku_key = catalog.sku_key
    );

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
  from public.upseller_product_import_rows where import_id = batch.id
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

  insert into public.upseller_stock_snapshots (
    organization_id, source_sku, sku_key, warehouse_name, warehouse_key,
    low_stock_threshold, purchase_in_transit, transfer_in_transit, occupied_quantity,
    available_quantity, current_quantity, average_cost, stock_value, state_hash, source_import_id
  )
  select organization_id, source_sku, sku_key, warehouse_name, warehouse_key,
    low_stock_threshold, purchase_in_transit, transfer_in_transit, occupied_quantity,
    available_quantity, current_quantity, average_cost, stock_value, state_hash, import_id
  from public.upseller_stock_import_rows where import_id = batch.id
  on conflict (organization_id, sku_key, warehouse_key, state_hash) do nothing;

  -- A SKU/warehouse absent from the new complete stock photograph becomes
  -- UNKNOWN by removing the old current row; it is never rewritten as zero.
  delete from public.upseller_stock_states as state
  where state.organization_id = batch.organization_id
    and not exists (
      select 1 from public.upseller_stock_import_rows as staging
      where staging.import_id = batch.id and staging.sku_key = state.sku_key
        and staging.warehouse_key = state.warehouse_key
    );

  insert into public.upseller_stock_states (
    organization_id, source_sku, sku_key, title, warehouse_name, warehouse_key, shelf,
    low_stock_threshold, purchase_in_transit, transfer_in_transit, occupied_quantity,
    available_quantity, current_quantity, average_cost, stock_value, source_created_at_raw,
    state_hash, source_import_id, checked_at
  )
  select organization_id, source_sku, sku_key, title, warehouse_name, warehouse_key, shelf,
    low_stock_threshold, purchase_in_transit, transfer_in_transit, occupied_quantity,
    available_quantity, current_quantity, average_cost, stock_value, source_created_at_raw,
    state_hash, import_id, now()
  from public.upseller_stock_import_rows where import_id = batch.id
  on conflict (organization_id, sku_key, warehouse_key) do update set
    source_sku = excluded.source_sku, title = excluded.title, warehouse_name = excluded.warehouse_name,
    shelf = excluded.shelf, low_stock_threshold = excluded.low_stock_threshold,
    purchase_in_transit = excluded.purchase_in_transit,
    transfer_in_transit = excluded.transfer_in_transit,
    occupied_quantity = excluded.occupied_quantity, available_quantity = excluded.available_quantity,
    current_quantity = excluded.current_quantity, average_cost = excluded.average_cost,
    stock_value = excluded.stock_value, source_created_at_raw = excluded.source_created_at_raw,
    state_hash = excluded.state_hash, source_import_id = excluded.source_import_id,
    checked_at = excluded.checked_at;

  update public.upseller_channel_sku_relationships
  set is_current = false
  where organization_id = batch.organization_id and is_current;

  insert into public.upseller_store_aliases (
    organization_id, store_name, store_name_key, channel, ml_account_code
  ) values
    (batch.organization_id, 'mercado-ML- Speedbikers (loja 1)', 'MERCADO ML SPEEDBIKERS LOJA 1', 'mercado_livre', 'speedbikers'),
    (batch.organization_id, 'mercado-ML- Speedbikers (loja 2)', 'MERCADO ML SPEEDBIKERS LOJA 2', 'mercado_livre', 'offracer'),
    (batch.organization_id, 'mercado-ML - SbMotos', 'MERCADO ML SBMOTOS', 'mercado_livre', 'sb'),
    (batch.organization_id, 'mercado-ML - GMR', 'MERCADO ML GMR', 'mercado_livre', 'gmr')
  on conflict (organization_id, store_name_key) do update set
    channel = excluded.channel, ml_account_code = excluded.ml_account_code;

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
  from public.upseller_relationship_import_rows as staging
  left join public.upseller_store_aliases as alias
    on alias.organization_id = staging.organization_id
   and alias.store_name_key = staging.store_name_key
  left join public.ml_accounts as account
    on account.organization_id = staging.organization_id
   and account.code = alias.ml_account_code
  where staging.import_id = batch.id
  on conflict (
    organization_id, source_sku_key, mapped_listing_sku_key,
    listing_external_id, variant_external_id, store_name_key
  ) do update set
    source_sku = excluded.source_sku, mapped_listing_sku = excluded.mapped_listing_sku,
    variant_label = excluded.variant_label, store_name = excluded.store_name,
    channel = excluded.channel, ml_account_id = excluded.ml_account_id,
    source_updated_at_raw = excluded.source_updated_at_raw, row_hash = excluded.row_hash,
    is_current = true, source_import_id = excluded.source_import_id,
    raw_payload = excluded.raw_payload;

  update public.upseller_kit_components
  set is_current = false where organization_id = batch.organization_id and is_current;
  update public.upseller_kits
  set is_current = false where organization_id = batch.organization_id and is_current;

  insert into public.upseller_kits (
    organization_id, kit_sku, kit_sku_key, title, alias, invoice_alias_enabled,
    category, is_active, image_url, source_import_id, is_current
  )
  select distinct on (organization_id, kit_sku_key)
    organization_id, kit_sku, kit_sku_key, title, alias, invoice_alias_enabled,
    category, is_active, image_url, import_id, true
  from public.upseller_kit_component_import_rows
  where import_id = batch.id
  order by organization_id, kit_sku_key, row_number
  on conflict (organization_id, kit_sku_key) do update set
    kit_sku = excluded.kit_sku, title = excluded.title, alias = excluded.alias,
    invoice_alias_enabled = excluded.invoice_alias_enabled, category = excluded.category,
    is_active = excluded.is_active, image_url = excluded.image_url,
    source_import_id = excluded.source_import_id, is_current = true;

  insert into public.upseller_kit_components (
    organization_id, kit_sku_key, component_sku, component_sku_key,
    required_quantity, source_import_id, is_current
  )
  select organization_id, kit_sku_key, component_sku, component_sku_key,
    required_quantity, import_id, true
  from public.upseller_kit_component_import_rows where import_id = batch.id
  on conflict (organization_id, kit_sku_key, component_sku_key) do update set
    component_sku = excluded.component_sku, required_quantity = excluded.required_quantity,
    source_import_id = excluded.source_import_id, is_current = true;

  -- Build deterministic candidates in priority order. Relationships only resolve
  -- when their persisted store alias points to the same Mercado Livre account.
  create temporary table upseller_link_candidates (
    product_id uuid not null,
    source_sku text not null,
    source_sku_key text not null,
    source_kind text not null,
    link_method text not null,
    priority integer not null,
    evidence jsonb not null
  ) on commit drop;

  insert into upseller_link_candidates
  select product.id,
    coalesce(kit.kit_sku, catalog.source_sku, stock.source_sku, product.sku),
    product.sku_key,
    case when kit.kit_sku_key is not null then 'kit' else 'simple' end,
    'exact_sku', 1, jsonb_build_object('canonicalSku', product.sku)
  from public.products as product
  left join public.upseller_kits as kit
    on kit.organization_id = product.organization_id and kit.kit_sku_key = product.sku_key and kit.is_current
  left join public.upseller_product_catalog as catalog
    on catalog.organization_id = product.organization_id and catalog.sku_key = product.sku_key
  left join lateral (
    select state.source_sku from public.upseller_stock_states as state
    where state.organization_id = product.organization_id and state.sku_key = product.sku_key limit 1
  ) as stock on true
  where product.organization_id = batch.organization_id
    and (kit.kit_sku_key is not null or catalog.sku_key is not null or stock.source_sku is not null);

  insert into upseller_link_candidates
  select listing.product_id, relation.source_sku, relation.source_sku_key,
    case when kit.kit_sku_key is not null then 'kit' else 'simple' end,
    'ml_item_relationship', 2,
    jsonb_build_object('itemId', listing.item_id, 'storeName', relation.store_name, 'mlAccountId', listing.ml_account_id)
  from public.upseller_channel_sku_relationships as relation
  join public.ml_listings as listing
    on listing.organization_id = relation.organization_id
   and listing.ml_account_id = relation.ml_account_id
   and listing.item_id = relation.listing_external_id
   and listing.is_current and listing.product_id is not null
  left join public.upseller_kits as kit
    on kit.organization_id = relation.organization_id and kit.kit_sku_key = relation.source_sku_key and kit.is_current
  where relation.organization_id = batch.organization_id
    and relation.is_current and relation.channel = 'mercado_livre';

  insert into upseller_link_candidates
  select variation.product_id, relation.source_sku, relation.source_sku_key,
    case when kit.kit_sku_key is not null then 'kit' else 'simple' end,
    'ml_variation_relationship', 3,
    jsonb_build_object('itemId', listing.item_id, 'variationId', variation.variation_id, 'storeName', relation.store_name)
  from public.upseller_channel_sku_relationships as relation
  join public.ml_listings as listing
    on listing.organization_id = relation.organization_id
   and listing.ml_account_id = relation.ml_account_id
   and listing.item_id = relation.listing_external_id and listing.is_current
  join public.ml_listing_variations as variation
    on variation.ml_listing_id = listing.id
   and variation.variation_id = relation.variant_external_id
   and variation.is_current and variation.product_id is not null
  left join public.upseller_kits as kit
    on kit.organization_id = relation.organization_id and kit.kit_sku_key = relation.source_sku_key and kit.is_current
  where relation.organization_id = batch.organization_id
    and relation.is_current and relation.channel = 'mercado_livre';

  insert into upseller_link_candidates
  select target.product_id, relation.source_sku, relation.source_sku_key,
    case when kit.kit_sku_key is not null then 'kit' else 'simple' end,
    'ml_user_product_relationship', 4,
    jsonb_build_object('userProductId', relation.listing_external_id, 'storeName', relation.store_name)
  from public.upseller_channel_sku_relationships as relation
  join (
    select organization_id, ml_account_id, product_id, user_product_id
    from public.ml_listings
    where is_current and product_id is not null and user_product_id is not null
    union all
    select organization_id, ml_account_id, product_id, user_product_id
    from public.ml_listing_variations
    where is_current and product_id is not null and user_product_id is not null
  ) as target
    on target.organization_id = relation.organization_id
   and target.ml_account_id = relation.ml_account_id
   and target.user_product_id = relation.listing_external_id
  left join public.upseller_kits as kit
    on kit.organization_id = relation.organization_id and kit.kit_sku_key = relation.source_sku_key and kit.is_current
  where relation.organization_id = batch.organization_id and relation.is_current
    and relation.channel = 'mercado_livre' and relation.listing_external_id like 'MLBU%';

  update public.product_inventory_link_conflicts
  set is_current = false, resolved_at = now()
  where organization_id = batch.organization_id and source = 'upseller' and is_current;

  insert into public.product_inventory_link_conflicts (
    organization_id, product_id, source, candidate_source_skus, evidence, source_import_id, is_current
  )
  select batch.organization_id, candidate.product_id, 'upseller',
    jsonb_agg(distinct candidate.source_sku_key order by candidate.source_sku_key),
    jsonb_build_object('methods', jsonb_agg(distinct candidate.link_method)), batch.id, true
  from upseller_link_candidates as candidate
  group by candidate.product_id
  having count(distinct candidate.source_sku_key) > 1;

  update public.product_inventory_links
  set is_active = false
  where organization_id = batch.organization_id and source = 'upseller'
    and is_active and link_method <> 'manual';

  insert into public.product_inventory_links (
    organization_id, product_id, source, source_sku, source_sku_key, source_kind,
    link_method, confidence, source_import_id, evidence, is_active
  )
  select batch.organization_id, chosen.product_id, 'upseller', chosen.source_sku,
    chosen.source_sku_key, chosen.source_kind, chosen.link_method, 'exact', batch.id,
    chosen.evidence, true
  from (
    select distinct on (candidate.product_id) candidate.*
    from upseller_link_candidates as candidate
    where not exists (
      select 1 from public.product_inventory_link_conflicts as conflict
      where conflict.organization_id = batch.organization_id
        and conflict.product_id = candidate.product_id and conflict.source = 'upseller' and conflict.is_current
    )
    and not exists (
      select 1 from public.product_inventory_links as manual
      where manual.organization_id = batch.organization_id and manual.product_id = candidate.product_id
        and manual.source = 'upseller' and manual.link_method = 'manual' and manual.is_active
    )
    order by candidate.product_id, candidate.priority, candidate.source_sku_key
  ) as chosen
  on conflict (organization_id, product_id, source) where is_active do update set
    source_sku = excluded.source_sku, source_sku_key = excluded.source_sku_key,
    source_kind = excluded.source_kind, link_method = excluded.link_method,
    confidence = excluded.confidence, source_import_id = excluded.source_import_id,
    evidence = excluded.evidence, updated_at = now();

  insert into public.operational_alert_jobs (organization_id, product_id, reason)
  select product.organization_id, product.id, 'upseller_import'
  from public.products as product where product.organization_id = batch.organization_id
  on conflict (organization_id, product_id) where status in ('queued','running') do nothing;

  update public.upseller_import_batches
  set status = 'applied', phase = 'applied', cursor_row = 0,
      lease_id = null, lease_expires_at = null, error_code = null,
      error_message = null, applied_at = now()
  where id = batch.id;

  delete from public.upseller_stock_import_rows where import_id = batch.id;
  delete from public.upseller_product_import_rows where import_id = batch.id;
  delete from public.upseller_relationship_import_rows where import_id = batch.id;
  delete from public.upseller_kit_component_import_rows where import_id = batch.id;
  return true;
end;
$$;

create or replace function public.claim_next_fulfillment_stock_sync_run(
  requested_lease_id uuid,
  lease_duration_seconds integer default 120
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare claimed_id uuid;
begin
  if requested_lease_id is null then raise exception 'lease_id_required'; end if;
  with candidate as (
    select id from public.sync_runs
    where sync_type = 'fulfillment_stock_backfill' and status in ('queued','running')
      and next_attempt_at <= now() and (lease_id is null or lease_expires_at <= now())
    order by next_attempt_at, started_at for update skip locked limit 1
  )
  update public.sync_runs as run set status = 'running', lease_id = requested_lease_id,
    lease_expires_at = now() + make_interval(secs => lease_duration_seconds)
  from candidate where run.id = candidate.id returning run.id into claimed_id;
  return claimed_id;
end $$;

create or replace function public.get_fulfillment_inventory_targets(
  target_sync_run_id uuid,
  cursor_inventory_id text default null,
  requested_limit integer default 8
)
returns table(inventory_id text)
language sql security definer set search_path = '' as $$
  with target_account as (
    select organization_id, ml_account_id from public.sync_runs
    where id = target_sync_run_id and sync_type = 'fulfillment_stock_backfill'
  ), targets as (
    select listing.inventory_id
    from public.ml_listings as listing join target_account as target
      on target.organization_id = listing.organization_id and target.ml_account_id = listing.ml_account_id
    where listing.is_current and listing.inventory_id is not null
    union
    select variation.inventory_id
    from public.ml_listing_variations as variation join target_account as target
      on target.organization_id = variation.organization_id and target.ml_account_id = variation.ml_account_id
    where variation.is_current and variation.inventory_id is not null
  )
  select targets.inventory_id from targets
  where cursor_inventory_id is null or targets.inventory_id > cursor_inventory_id
  order by targets.inventory_id limit greatest(1, least(requested_limit, 32));
$$;

create or replace function public.claim_next_ml_fulfillment_refresh_job(
  requested_lease_id uuid,
  lease_duration_seconds integer default 120
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare claimed_id uuid;
begin
  with candidate as (
    select id from public.ml_fulfillment_stock_refresh_jobs
    where status in ('queued','running') and next_attempt_at <= now()
      and (lease_id is null or lease_expires_at <= now())
    order by next_attempt_at, created_at for update skip locked limit 1
  )
  update public.ml_fulfillment_stock_refresh_jobs as job
  set status = 'running', lease_id = requested_lease_id,
      lease_expires_at = now() + make_interval(secs => lease_duration_seconds),
      attempt_count = job.attempt_count + 1
  from candidate where job.id = candidate.id returning job.id into claimed_id;
  return claimed_id;
end $$;

create or replace function public.enqueue_ml_fulfillment_refresh_notification(
  requested_app_code text,
  requested_seller_id text,
  requested_notification_key text,
  requested_notification_id text,
  requested_operation_id text,
  requested_application_id text,
  requested_resource text,
  requested_raw_body text
)
returns text language plpgsql security definer set search_path = '' as $$
declare account public.ml_accounts%rowtype;
begin
  select * into account from public.ml_accounts
  where seller_id = requested_seller_id and oauth_app_code = requested_app_code
  order by is_active desc limit 1;
  if account.id is null then return 'unknown_account'; end if;

  insert into public.ml_fulfillment_stock_refresh_jobs (
    organization_id, ml_account_id, notification_key, notification_id,
    operation_id, seller_id, application_id, resource, raw_body
  ) values (
    account.organization_id, account.id, requested_notification_key, requested_notification_id,
    requested_operation_id, requested_seller_id, requested_application_id,
    requested_resource, requested_raw_body
  ) on conflict (notification_key) do nothing;
  if found then return 'queued'; end if;
  return 'duplicate';
end $$;

create or replace function public.claim_next_operational_alert_job(
  requested_lease_id uuid,
  lease_duration_seconds integer default 120
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare claimed_id uuid;
begin
  with candidate as (
    select id from public.operational_alert_jobs
    where status in ('queued','running') and next_attempt_at <= now()
      and (lease_id is null or lease_expires_at <= now())
    order by next_attempt_at, created_at for update skip locked limit 1
  )
  update public.operational_alert_jobs as job
  set status = 'running', lease_id = requested_lease_id,
      lease_expires_at = now() + make_interval(secs => lease_duration_seconds),
      attempt_count = job.attempt_count + 1
  from candidate where job.id = candidate.id returning job.id into claimed_id;
  return claimed_id;
end $$;

create or replace function public.apply_product_operational_alerts(
  target_organization_id uuid,
  target_product_id uuid,
  current_alerts jsonb
)
returns integer language plpgsql security definer set search_path = '' as $$
declare item jsonb; touched integer := 0; current_keys text[] := array[]::text[];
begin
  if (select auth.role()) <> 'service_role' then raise exception 'not_authorized'; end if;
  if jsonb_typeof(coalesce(current_alerts, '[]'::jsonb)) <> 'array' then raise exception 'alerts_must_be_array'; end if;

  for item in select value from jsonb_array_elements(coalesce(current_alerts, '[]'::jsonb))
  loop
    if nullif(item ->> 'dedupeKey','') is null or nullif(item ->> 'alertType','') is null
      or (item ->> 'severity') not in ('critical','warning','info') then
      raise exception 'invalid_alert';
    end if;
    current_keys := array_append(current_keys, item ->> 'dedupeKey');

    update public.operational_alerts set
      severity = item ->> 'severity', evidence = coalesce(item -> 'evidence','{}'::jsonb),
      suggested_action_code = nullif(item ->> 'suggestedActionCode',''),
      last_seen_at = now(), last_evaluated_at = now(), updated_at = now()
    where organization_id = target_organization_id and product_id = target_product_id
      and dedupe_key = item ->> 'dedupeKey' and status = 'open';

    if not found then
      begin
        insert into public.operational_alerts (
          organization_id, product_id, alert_type, severity, status, dedupe_key,
          evidence, suggested_action_code
        ) values (
          target_organization_id, target_product_id, item ->> 'alertType', item ->> 'severity',
          'open', item ->> 'dedupeKey', coalesce(item -> 'evidence','{}'::jsonb),
          nullif(item ->> 'suggestedActionCode','')
        );
      exception when unique_violation then
        update public.operational_alerts set last_seen_at = now(), last_evaluated_at = now()
        where organization_id = target_organization_id and dedupe_key = item ->> 'dedupeKey' and status = 'open';
      end;
    end if;
    touched := touched + 1;
  end loop;

  update public.operational_alerts set status = 'resolved', resolved_at = now(),
    last_evaluated_at = now(), updated_at = now()
  where organization_id = target_organization_id and product_id = target_product_id
    and status = 'open' and not (dedupe_key = any(current_keys));
  return touched;
end $$;

-- Queue initial and daily Full reconciliation without duplicating active runs.
create or replace function private.enqueue_fulfillment_stock_reconciliation()
returns integer language plpgsql security definer set search_path = '' as $$
declare account record; target_count integer; inserted_count integer := 0;
begin
  for account in select organization_id, id from public.ml_accounts
    where is_active and connection_status = 'connected'
  loop
    select count(*) into target_count from (
      select inventory_id from public.ml_listings
      where organization_id = account.organization_id and ml_account_id = account.id
        and is_current and inventory_id is not null
      union
      select inventory_id from public.ml_listing_variations
      where organization_id = account.organization_id and ml_account_id = account.id
        and is_current and inventory_id is not null
    ) as targets;
    if target_count > 0 then
      insert into public.sync_runs (
        organization_id, ml_account_id, sync_type, status, cursor_offset, batch_size,
        records_discovered, records_processed, records_upserted, retry_count,
        max_retries, requested_by, metadata
      ) values (
        account.organization_id, account.id, 'fulfillment_stock_backfill', 'queued', 0, 8,
        target_count, 0, 0, 0, 5, null,
        jsonb_build_object('cursor_inventory_id', null, 'mode', 'reconcile', 'failure_count', 0)
      ) on conflict do nothing;
      if found then inserted_count := inserted_count + 1; end if;
    end if;
  end loop;
  return inserted_count;
end $$;

select private.enqueue_fulfillment_stock_reconciliation();

create or replace function private.enqueue_operational_alert_reconciliation()
returns integer language plpgsql security definer set search_path = '' as $$
declare inserted_count integer;
begin
  insert into public.operational_alert_jobs (organization_id, product_id, reason)
  select product.organization_id, product.id, 'periodic_reconcile' from public.products as product
  on conflict (organization_id, product_id) where status in ('queued','running') do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count;
end $$;

create or replace function private.dispatch_due_stock_workers(worker_task text, maximum integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare due_count integer; current_dispatch integer;
begin
  if worker_task = 'upseller_import' then
    select least(count(*)::integer, maximum) into due_count from public.upseller_import_batches
    where status in ('queued','running') and next_attempt_at <= now()
      and (lease_id is null or lease_expires_at <= now());
  elsif worker_task = 'fulfillment_stock_backfill' then
    select least(count(*)::integer, maximum) into due_count from public.sync_runs
    where sync_type = 'fulfillment_stock_backfill' and status in ('queued','running')
      and next_attempt_at <= now() and (lease_id is null or lease_expires_at <= now());
  elsif worker_task = 'fulfillment_stock_refresh' then
    select least(count(*)::integer, maximum) into due_count from public.ml_fulfillment_stock_refresh_jobs
    where status in ('queued','running') and next_attempt_at <= now()
      and (lease_id is null or lease_expires_at <= now());
  elsif worker_task = 'operational_alerts' then
    select least(count(*)::integer, maximum) into due_count from public.operational_alert_jobs
    where status in ('queued','running') and next_attempt_at <= now()
      and (lease_id is null or lease_expires_at <= now());
  else
    raise exception 'unsupported_worker_task';
  end if;

  for current_dispatch in 1..coalesce(due_count, 0) loop
    perform private.dispatch_ml_sync_worker_task(worker_task);
  end loop;
  return coalesce(due_count, 0);
end $$;

create or replace function public.get_stock_backend_status(target_organization_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  latest_import public.upseller_import_batches%rowtype;
  mapped_count integer; missing_count integer; conflict_count integer;
  physical_ready_count integer; physical_unknown_count integer; warehouse_count integer;
  target_count integer; checked_count integer; failed_count integer;
  alert_open integer; alert_critical integer; alert_warning integer; alert_info integer;
  full_working boolean;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'not_authorized'; end if;
  select * into latest_import from public.upseller_import_batches
  where organization_id = target_organization_id order by created_at desc limit 1;

  select count(*) into mapped_count from public.product_inventory_links
  where organization_id = target_organization_id and source = 'upseller' and is_active;
  select count(*) into conflict_count from public.product_inventory_link_conflicts
  where organization_id = target_organization_id and source = 'upseller' and is_current;
  select count(*) into missing_count from (
    select product_id from public.ml_listings
    where organization_id = target_organization_id and is_current and product_id is not null
    union
    select product_id from public.ml_listing_variations
    where organization_id = target_organization_id and is_current and product_id is not null
  ) as listed
  where not exists (
    select 1 from public.product_inventory_links as link
    where link.organization_id = target_organization_id and link.product_id = listed.product_id
      and link.source = 'upseller' and link.is_active
  ) and not exists (
    select 1 from public.product_inventory_link_conflicts as conflict
    where conflict.organization_id = target_organization_id and conflict.product_id = listed.product_id
      and conflict.source = 'upseller' and conflict.is_current
  );

  select count(*) into physical_ready_count from public.product_inventory_links as link
  where link.organization_id = target_organization_id and link.source = 'upseller' and link.is_active
    and (
      (link.source_kind = 'simple' and exists (
        select 1 from public.upseller_stock_states as state
        where state.organization_id = link.organization_id and state.sku_key = link.source_sku_key
      ))
      or
      (link.source_kind = 'kit'
       and exists (select 1 from public.upseller_kit_components as component where component.organization_id = link.organization_id and component.kit_sku_key = link.source_sku_key and component.is_current)
       and not exists (
         select 1 from public.upseller_kit_components as component
         where component.organization_id = link.organization_id and component.kit_sku_key = link.source_sku_key and component.is_current
           and not exists (select 1 from public.upseller_stock_states as state where state.organization_id = component.organization_id and state.sku_key = component.component_sku_key)
       ))
    );
  physical_unknown_count := greatest(mapped_count - physical_ready_count, 0);
  select count(distinct warehouse_key) into warehouse_count from public.upseller_stock_states
  where organization_id = target_organization_id;

  select count(*) into target_count from (
    select ml_account_id, inventory_id from public.ml_listings
    where organization_id = target_organization_id and is_current and inventory_id is not null
    union
    select ml_account_id, inventory_id from public.ml_listing_variations
    where organization_id = target_organization_id and is_current and inventory_id is not null
  ) as targets;
  select count(*) into checked_count from (
    select targets.ml_account_id, targets.inventory_id
    from (
      select ml_account_id, inventory_id from public.ml_listings
      where organization_id = target_organization_id and is_current and inventory_id is not null
      union
      select ml_account_id, inventory_id from public.ml_listing_variations
      where organization_id = target_organization_id and is_current and inventory_id is not null
    ) as targets
    join public.ml_fulfillment_stock_states as state
      on state.organization_id = target_organization_id
     and state.ml_account_id = targets.ml_account_id and state.inventory_id = targets.inventory_id
  ) as checked;
  select count(*) into failed_count from public.sync_runs
  where organization_id = target_organization_id and sync_type = 'fulfillment_stock_backfill' and status = 'failed';
  full_working := target_count = 0 or checked_count > 0 or exists (
    select 1 from public.sync_runs where organization_id = target_organization_id
      and sync_type = 'fulfillment_stock_backfill' and status in ('queued','running','succeeded')
  );

  select count(*), count(*) filter (where severity = 'critical'),
    count(*) filter (where severity = 'warning'), count(*) filter (where severity = 'info')
  into alert_open, alert_critical, alert_warning, alert_info
  from public.operational_alerts where organization_id = target_organization_id and status = 'open';

  return jsonb_build_object(
    'upseller', jsonb_build_object(
      'latestImportId', latest_import.id, 'status', latest_import.status,
      'importedAt', latest_import.applied_at,
      'stockRows', latest_import.preview_summary -> 'stockRows',
      'productRows', latest_import.preview_summary -> 'productRows',
      'relationshipRows', latest_import.preview_summary -> 'relationshipRows',
      'kitCount', latest_import.preview_summary -> 'kitCount',
      'warehouseCount', warehouse_count, 'mappedProducts', mapped_count,
      'missingProductLinks', missing_count, 'conflictingProductLinks', conflict_count,
      'physicalReadyProducts', physical_ready_count, 'physicalUnknownProducts', physical_unknown_count
    ),
    'full', jsonb_build_object(
      'inventoryTargets', target_count, 'checked', checked_count,
      'pending', greatest(target_count - checked_count, 0), 'failed', failed_count,
      'coveragePercent', case when target_count = 0 then 100 else round(checked_count * 100.0 / target_count, 2) end,
      'runs', coalesce((select jsonb_agg(to_jsonb(run_summary) order by run_summary.started_at desc) from (
        select id, ml_account_id, status, records_discovered, records_processed,
          records_upserted, started_at, finished_at, error_code
        from public.sync_runs where organization_id = target_organization_id
          and sync_type = 'fulfillment_stock_backfill' order by started_at desc limit 8
      ) as run_summary), '[]'::jsonb),
      'refreshJobs', jsonb_build_object(
        'queued', (select count(*) from public.ml_fulfillment_stock_refresh_jobs where organization_id = target_organization_id and status = 'queued'),
        'running', (select count(*) from public.ml_fulfillment_stock_refresh_jobs where organization_id = target_organization_id and status = 'running'),
        'succeeded', (select count(*) from public.ml_fulfillment_stock_refresh_jobs where organization_id = target_organization_id and status = 'succeeded'),
        'failed', (select count(*) from public.ml_fulfillment_stock_refresh_jobs where organization_id = target_organization_id and status = 'failed'),
        'ignored', (select count(*) from public.ml_fulfillment_stock_refresh_jobs where organization_id = target_organization_id and status = 'ignored')
      )
    ),
    'alerts', jsonb_build_object(
      'open', alert_open, 'critical', alert_critical, 'warning', alert_warning, 'info', alert_info,
      'byType', coalesce((select jsonb_object_agg(alert_type, alert_count) from (
        select alert_type, count(*) as alert_count from public.operational_alerts
        where organization_id = target_organization_id and status = 'open' group by alert_type
      ) as grouped), '{}'::jsonb)
    ),
    'readiness', jsonb_build_object(
      'upsellerImportApplied', latest_import.status = 'applied',
      'mappingPipelineWorking', latest_import.status = 'applied',
      'fullPipelineWorking', full_working,
      'readyForVisualStage', latest_import.status = 'applied' and full_working
    )
  );
end $$;

do $$
declare job record;
begin
  for job in select jobid from cron.job where jobname in (
    'upseller-import-workers-every-minute','ml-fulfillment-workers-every-minute',
    'ml-fulfillment-refresh-workers-every-minute','operational-alert-workers-every-minute',
    'ml-fulfillment-reconcile-daily','operational-alert-reconcile-daily'
  ) loop perform cron.unschedule(job.jobid); end loop;
end $$;

select cron.schedule('upseller-import-workers-every-minute', '* * * * *',
  $$select private.dispatch_due_stock_workers('upseller_import', 1);$$);
select cron.schedule('ml-fulfillment-workers-every-minute', '* * * * *',
  $$select private.dispatch_due_stock_workers('fulfillment_stock_backfill', 4);$$);
select cron.schedule('ml-fulfillment-refresh-workers-every-minute', '* * * * *',
  $$select private.dispatch_due_stock_workers('fulfillment_stock_refresh', 4);$$);
select cron.schedule('operational-alert-workers-every-minute', '* * * * *',
  $$select private.dispatch_due_stock_workers('operational_alerts', 4);$$);
select cron.schedule('ml-fulfillment-reconcile-daily', '31 7 * * *',
  $$select private.enqueue_fulfillment_stock_reconciliation();$$);
select cron.schedule('operational-alert-reconcile-daily', '43 7 * * *',
  $$select private.enqueue_operational_alert_reconciliation();$$);

-- Public RPCs are service-role only.
revoke all on function public.claim_next_upseller_import(uuid, integer) from public, anon, authenticated;
revoke all on function public.promote_upseller_import(uuid) from public, anon, authenticated;
revoke all on function public.claim_next_fulfillment_stock_sync_run(uuid, integer) from public, anon, authenticated;
revoke all on function public.get_fulfillment_inventory_targets(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.claim_next_ml_fulfillment_refresh_job(uuid, integer) from public, anon, authenticated;
revoke all on function public.enqueue_ml_fulfillment_refresh_notification(text,text,text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.claim_next_operational_alert_job(uuid, integer) from public, anon, authenticated;
revoke all on function public.apply_product_operational_alerts(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.get_stock_backend_status(uuid) from public, anon, authenticated;

grant execute on function public.claim_next_upseller_import(uuid, integer) to service_role;
grant execute on function public.promote_upseller_import(uuid) to service_role;
grant execute on function public.claim_next_fulfillment_stock_sync_run(uuid, integer) to service_role;
grant execute on function public.get_fulfillment_inventory_targets(uuid, text, integer) to service_role;
grant execute on function public.claim_next_ml_fulfillment_refresh_job(uuid, integer) to service_role;
grant execute on function public.enqueue_ml_fulfillment_refresh_notification(text,text,text,text,text,text,text,text) to service_role;
grant execute on function public.claim_next_operational_alert_job(uuid, integer) to service_role;
grant execute on function public.apply_product_operational_alerts(uuid, uuid, jsonb) to service_role;
grant execute on function public.get_stock_backend_status(uuid) to service_role;

revoke all on function private.enqueue_fulfillment_stock_reconciliation() from public, anon, authenticated, service_role;
revoke all on function private.enqueue_operational_alert_reconciliation() from public, anon, authenticated, service_role;
revoke all on function private.dispatch_due_stock_workers(text, integer) from public, anon, authenticated, service_role;
