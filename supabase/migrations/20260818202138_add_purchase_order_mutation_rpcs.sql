-- Purchase order lifecycle mutation RPCs. Each is service_role-only,
-- authorizes in-body against organization_members (mirrors
-- apply_nfe_stock_receipt's pattern), row-locks the purchase order with
-- `for update`, and enforces optimistic concurrency via expected_version
-- -> 'stale_purchase_order'.

create or replace function public.create_supplier(
  target_organization_id uuid,
  actor_user_id uuid,
  name text,
  legal_name text default null,
  document text default null,
  contact_name text default null,
  email text default null,
  phone text default null,
  whatsapp text default null,
  website text default null,
  notes text default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  new_supplier_id uuid;
begin
  if not exists (
    select 1 from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = actor_user_id
      and membership.is_active
      and membership.role in ('admin'::public.app_role, 'gestor'::public.app_role, 'operador'::public.app_role)
  ) then
    raise exception 'purchase_order_not_authorized';
  end if;

  if nullif(btrim(name), '') is null then
    raise exception 'invalid_supplier_name';
  end if;

  insert into public.suppliers (
    organization_id, name, legal_name, document, contact_name, email, phone, whatsapp, website, notes, created_by
  ) values (
    target_organization_id, btrim(name), legal_name, document, contact_name, email, phone, whatsapp, website, notes, actor_user_id
  )
  returning id into new_supplier_id;

  return new_supplier_id;
end;
$$;

create or replace function public.update_supplier(
  target_organization_id uuid,
  actor_user_id uuid,
  target_supplier_id uuid,
  name text default null,
  legal_name text default null,
  document text default null,
  contact_name text default null,
  email text default null,
  phone text default null,
  whatsapp text default null,
  website text default null,
  notes text default null,
  is_active boolean default null
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  current_supplier public.suppliers%rowtype;
begin
  if not exists (
    select 1 from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = actor_user_id
      and membership.is_active
      and membership.role in ('admin'::public.app_role, 'gestor'::public.app_role, 'operador'::public.app_role)
  ) then
    raise exception 'purchase_order_not_authorized';
  end if;

  select * into current_supplier from public.suppliers
  where id = target_supplier_id and organization_id = target_organization_id;

  if current_supplier.id is null then raise exception 'supplier_not_found'; end if;

  update public.suppliers set
    name = coalesce(nullif(btrim(update_supplier.name), ''), current_supplier.name),
    legal_name = coalesce(update_supplier.legal_name, current_supplier.legal_name),
    document = coalesce(update_supplier.document, current_supplier.document),
    contact_name = coalesce(update_supplier.contact_name, current_supplier.contact_name),
    email = coalesce(update_supplier.email, current_supplier.email),
    phone = coalesce(update_supplier.phone, current_supplier.phone),
    whatsapp = coalesce(update_supplier.whatsapp, current_supplier.whatsapp),
    website = coalesce(update_supplier.website, current_supplier.website),
    notes = coalesce(update_supplier.notes, current_supplier.notes),
    is_active = coalesce(update_supplier.is_active, current_supplier.is_active)
  where id = target_supplier_id;

  return 1;
end;
$$;

create or replace function public.create_blank_purchase_order(
  target_organization_id uuid,
  actor_user_id uuid,
  notes text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  new_purchase_order_id uuid;
  new_order_number bigint;
begin
  if not exists (
    select 1 from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = actor_user_id
      and membership.is_active
      and membership.role in ('admin'::public.app_role, 'gestor'::public.app_role, 'operador'::public.app_role)
  ) then
    raise exception 'purchase_order_not_authorized';
  end if;

  insert into public.purchase_orders (organization_id, status, notes, created_by)
  values (target_organization_id, 'draft', notes, actor_user_id)
  returning id, order_number into new_purchase_order_id, new_order_number;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (target_organization_id, new_purchase_order_id, 'created', actor_user_id, jsonb_build_object('origin', 'blank'));

  return jsonb_build_object('purchaseOrderId', new_purchase_order_id, 'orderNumber', new_order_number);
end;
$$;

create or replace function public.create_purchase_order_from_planning(
  target_organization_id uuid,
  actor_user_id uuid,
  source_sku_keys text[],
  destination_warehouse_key text default null,
  destination_warehouse_name text default null,
  notes text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  new_purchase_order_id uuid;
  new_order_number bigint;
  signal record;
  inserted_items integer := 0;
  existing_open jsonb;
begin
  if not exists (
    select 1 from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = actor_user_id
      and membership.is_active
      and membership.role in ('admin'::public.app_role, 'gestor'::public.app_role, 'operador'::public.app_role)
  ) then
    raise exception 'purchase_order_not_authorized';
  end if;

  if source_sku_keys is null or array_length(source_sku_keys, 1) is null then
    raise exception 'invalid_purchase_order_items';
  end if;

  -- Duplicate guard: any requested SKU already active in an open PO
  -- (draft/approved/ordered/partially_received) blocks the WHOLE
  -- creation — all-or-nothing, no silent partial creation.
  select coalesce(jsonb_agg(jsonb_build_object(
    'sourceSkuKey', found_item.source_sku_key,
    'purchaseOrderId', found_po.id,
    'orderNumber', found_po.order_number,
    'status', found_po.status
  )), '[]'::jsonb)
  into existing_open
  from public.purchase_order_items as found_item
  join public.purchase_orders as found_po on found_po.id = found_item.purchase_order_id
  where found_po.organization_id = target_organization_id
    and found_po.status in ('draft', 'approved', 'ordered', 'partially_received')
    and found_item.source_sku_key = any(source_sku_keys);

  if jsonb_array_length(existing_open) > 0 then
    return jsonb_build_object('created', false, 'existingOpenOrders', existing_open);
  end if;

  insert into public.purchase_orders (
    organization_id, status, destination_warehouse_key, destination_warehouse_name,
    notes, created_by
  ) values (
    target_organization_id, 'draft', destination_warehouse_key, destination_warehouse_name,
    notes, actor_user_id
  )
  returning id, order_number into new_purchase_order_id, new_order_number;

  -- Re-derive planning fresh, inside the same transaction — never
  -- trust anything the client sent beyond the SKU list itself.
  for signal in
    select *
    from private.get_purchase_planning_signals(target_organization_id)
    where source_sku_key = any(source_sku_keys)
  loop
    insert into public.purchase_order_items (
      organization_id, purchase_order_id, source_sku, source_sku_key,
      title_snapshot, brand_snapshot, quantity_ordered, unit_cost,
      suggested_quantity_snapshot, physical_available_snapshot,
      upseller_purchase_in_transit_snapshot, avg_daily_sales_30_snapshot,
      lead_time_days_snapshot, low_stock_threshold_snapshot,
      projected_stock_at_arrival_snapshot, planning_status_snapshot,
      planning_generated_at
    ) values (
      target_organization_id, new_purchase_order_id, signal.source_sku, signal.source_sku_key,
      signal.title, signal.brand,
      greatest(coalesce(signal.suggested_purchase_quantity, 0), 1),
      signal.unit_cost,
      signal.suggested_purchase_quantity, signal.physical_available,
      signal.upseller_purchase_in_transit, signal.avg_daily_sales_30,
      signal.lead_time_days, signal.low_stock_threshold,
      signal.projected_stock_at_arrival, signal.status,
      now()
    );
    inserted_items := inserted_items + 1;
  end loop;

  if inserted_items = 0 then
    raise exception 'invalid_purchase_order_items';
  end if;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (target_organization_id, new_purchase_order_id, 'created', actor_user_id,
    jsonb_build_object('sourceSkuKeys', source_sku_keys, 'itemCount', inserted_items, 'origin', 'planning'));

  return jsonb_build_object('created', true, 'purchaseOrderId', new_purchase_order_id, 'orderNumber', new_order_number);
end;
$$;

create or replace function public.update_purchase_order_draft(
  target_organization_id uuid,
  actor_user_id uuid,
  target_purchase_order_id uuid,
  expected_version integer,
  supplier_id uuid default null,
  destination_warehouse_key text default null,
  destination_warehouse_name text default null,
  notes text default null,
  expected_at timestamptz default null,
  clear_notes boolean default false,
  clear_expected_at boolean default false
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  current_po public.purchase_orders%rowtype;
  previous_supplier_id uuid;
begin
  if not exists (
    select 1 from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = actor_user_id
      and membership.is_active
      and membership.role in ('admin'::public.app_role, 'gestor'::public.app_role, 'operador'::public.app_role)
  ) then
    raise exception 'purchase_order_not_authorized';
  end if;

  select * into current_po from public.purchase_orders
  where id = target_purchase_order_id and organization_id = target_organization_id
  for update;

  if current_po.id is null then raise exception 'purchase_order_not_found'; end if;
  if current_po.version <> expected_version then raise exception 'stale_purchase_order'; end if;
  if current_po.status <> 'draft' then raise exception 'purchase_order_not_draft'; end if;

  previous_supplier_id := current_po.supplier_id;

  update public.purchase_orders set
    supplier_id = coalesce(supplier_id, current_po.supplier_id),
    destination_warehouse_key = coalesce(destination_warehouse_key, current_po.destination_warehouse_key),
    destination_warehouse_name = coalesce(destination_warehouse_name, current_po.destination_warehouse_name),
    notes = case when clear_notes then null else coalesce(notes, current_po.notes) end,
    expected_at = case when clear_expected_at then null else coalesce(expected_at, current_po.expected_at) end,
    version = current_po.version + 1
  where id = target_purchase_order_id;

  if supplier_id is not null and supplier_id <> previous_supplier_id then
    insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
    values (target_organization_id, target_purchase_order_id, 'supplier_changed', actor_user_id,
      jsonb_build_object('from', previous_supplier_id, 'to', supplier_id));
  else
    insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
    values (target_organization_id, target_purchase_order_id, 'updated', actor_user_id, '{}'::jsonb);
  end if;

  return current_po.version + 1;
end;
$$;

create or replace function public.upsert_purchase_order_item(
  target_organization_id uuid,
  actor_user_id uuid,
  target_purchase_order_id uuid,
  expected_version integer,
  source_sku_key text,
  quantity_ordered numeric,
  unit_cost numeric default null,
  is_manual_add boolean default false
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  current_po public.purchase_orders%rowtype;
  existing_item public.purchase_order_items%rowtype;
  signal record;
  resolved_sku text;
  resolved_title text;
  resolved_brand text;
  new_item_id uuid;
begin
  if not exists (
    select 1 from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = actor_user_id
      and membership.is_active
      and membership.role in ('admin'::public.app_role, 'gestor'::public.app_role, 'operador'::public.app_role)
  ) then
    raise exception 'purchase_order_not_authorized';
  end if;

  if quantity_ordered is null or quantity_ordered <= 0 then
    raise exception 'invalid_purchase_order_quantity';
  end if;

  select * into current_po from public.purchase_orders
  where id = target_purchase_order_id and organization_id = target_organization_id
  for update;

  if current_po.id is null then raise exception 'purchase_order_not_found'; end if;
  if current_po.version <> expected_version then raise exception 'stale_purchase_order'; end if;
  if current_po.status <> 'draft' then raise exception 'purchase_order_not_draft'; end if;

  select * into existing_item from public.purchase_order_items
  where purchase_order_id = target_purchase_order_id and source_sku_key = upsert_purchase_order_item.source_sku_key;

  if existing_item.id is not null then
    -- Editing an existing item: quantity/cost only, snapshot is fixed
    -- at add-time for auditability, never recomputed here.
    update public.purchase_order_items set
      quantity_ordered = upsert_purchase_order_item.quantity_ordered,
      unit_cost = coalesce(upsert_purchase_order_item.unit_cost, existing_item.unit_cost)
    where id = existing_item.id;
    new_item_id := existing_item.id;
  else
    if is_manual_add then
      if exists (
        select 1 from public.upseller_kits
        where organization_id = target_organization_id
          and kit_sku_key = upsert_purchase_order_item.source_sku_key
          and is_current
      ) then
        raise exception 'cannot_add_kit_sku';
      end if;
    end if;

    select max(catalog.source_sku), max(catalog.title), max(catalog.brand)
    into resolved_sku, resolved_title, resolved_brand
    from public.upseller_product_catalog as catalog
    where catalog.organization_id = target_organization_id
      and catalog.sku_key = upsert_purchase_order_item.source_sku_key;

    select * into signal
    from private.get_purchase_planning_signals(target_organization_id)
    where source_sku_key = upsert_purchase_order_item.source_sku_key
    limit 1;

    insert into public.purchase_order_items (
      organization_id, purchase_order_id, source_sku, source_sku_key,
      title_snapshot, brand_snapshot, quantity_ordered, unit_cost,
      suggested_quantity_snapshot, physical_available_snapshot,
      upseller_purchase_in_transit_snapshot, avg_daily_sales_30_snapshot,
      lead_time_days_snapshot, low_stock_threshold_snapshot,
      projected_stock_at_arrival_snapshot, planning_status_snapshot,
      planning_generated_at
    ) values (
      target_organization_id, target_purchase_order_id,
      coalesce(resolved_sku, upsert_purchase_order_item.source_sku_key), upsert_purchase_order_item.source_sku_key,
      coalesce(signal.title, resolved_title), coalesce(signal.brand, resolved_brand),
      upsert_purchase_order_item.quantity_ordered, upsert_purchase_order_item.unit_cost,
      signal.suggested_purchase_quantity, signal.physical_available,
      signal.upseller_purchase_in_transit, signal.avg_daily_sales_30,
      signal.lead_time_days, signal.low_stock_threshold,
      signal.projected_stock_at_arrival,
      case when signal.source_sku_key is null then 'manual_add' else signal.status end,
      now()
    )
    returning id into new_item_id;
  end if;

  update public.purchase_orders set version = version + 1 where id = target_purchase_order_id;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (target_organization_id, target_purchase_order_id, 'updated', actor_user_id,
    jsonb_build_object('sourceSkuKey', source_sku_key, 'quantityOrdered', quantity_ordered));

  return jsonb_build_object('purchaseOrderItemId', new_item_id, 'version', current_po.version + 1);
end;
$$;

create or replace function public.remove_purchase_order_item(
  target_organization_id uuid,
  actor_user_id uuid,
  target_purchase_order_id uuid,
  expected_version integer,
  target_purchase_order_item_id uuid
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  current_po public.purchase_orders%rowtype;
begin
  if not exists (
    select 1 from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = actor_user_id
      and membership.is_active
      and membership.role in ('admin'::public.app_role, 'gestor'::public.app_role, 'operador'::public.app_role)
  ) then
    raise exception 'purchase_order_not_authorized';
  end if;

  select * into current_po from public.purchase_orders
  where id = target_purchase_order_id and organization_id = target_organization_id
  for update;

  if current_po.id is null then raise exception 'purchase_order_not_found'; end if;
  if current_po.version <> expected_version then raise exception 'stale_purchase_order'; end if;
  if current_po.status <> 'draft' then raise exception 'purchase_order_not_draft'; end if;

  if exists (
    select 1 from public.stock_receipt_items where purchase_order_item_id = target_purchase_order_item_id
  ) then
    raise exception 'purchase_order_item_has_receipts';
  end if;

  delete from public.purchase_order_items
  where id = target_purchase_order_item_id and purchase_order_id = target_purchase_order_id;

  update public.purchase_orders set version = version + 1 where id = target_purchase_order_id;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (target_organization_id, target_purchase_order_id, 'updated', actor_user_id,
    jsonb_build_object('removedItemId', target_purchase_order_item_id));

  return current_po.version + 1;
end;
$$;

create or replace function public.upsert_supplier_product_link(
  target_organization_id uuid,
  actor_user_id uuid,
  supplier_id uuid,
  source_sku_key text,
  source_sku text default null,
  supplier_sku text default null,
  is_preferred boolean default false,
  last_ordered_unit_cost numeric default null,
  confirm_replace boolean default false
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  current_preferred_supplier_id uuid;
  link_id uuid;
begin
  if not exists (
    select 1 from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = actor_user_id
      and membership.is_active
      and membership.role in ('admin'::public.app_role, 'gestor'::public.app_role, 'operador'::public.app_role)
  ) then
    raise exception 'purchase_order_not_authorized';
  end if;

  if is_preferred then
    select spl.supplier_id into current_preferred_supplier_id
    from public.supplier_product_links as spl
    where spl.organization_id = target_organization_id
      and spl.source_sku_key = upsert_supplier_product_link.source_sku_key
      and spl.is_preferred
      and spl.supplier_id <> upsert_supplier_product_link.supplier_id;

    if current_preferred_supplier_id is not null and not confirm_replace then
      return jsonb_build_object('replaced', false, 'currentPreferredSupplierId', current_preferred_supplier_id);
    end if;

    if current_preferred_supplier_id is not null then
      update public.supplier_product_links set is_preferred = false
      where organization_id = target_organization_id
        and source_sku_key = upsert_supplier_product_link.source_sku_key
        and supplier_id = current_preferred_supplier_id;
    end if;
  end if;

  insert into public.supplier_product_links (
    organization_id, supplier_id, source_sku, source_sku_key, supplier_sku, is_preferred, last_ordered_unit_cost
  ) values (
    target_organization_id, supplier_id, coalesce(source_sku, source_sku_key), source_sku_key, supplier_sku, is_preferred, last_ordered_unit_cost
  )
  on conflict (organization_id, supplier_id, source_sku_key)
  do update set
    supplier_sku = excluded.supplier_sku,
    is_preferred = excluded.is_preferred,
    last_ordered_unit_cost = excluded.last_ordered_unit_cost
  returning id into link_id;

  return jsonb_build_object('replaced', true, 'supplierProductLinkId', link_id);
end;
$$;

create or replace function public.approve_purchase_order(
  target_organization_id uuid,
  actor_user_id uuid,
  target_purchase_order_id uuid,
  expected_version integer
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  current_po public.purchase_orders%rowtype;
  item_count integer;
begin
  if not exists (
    select 1 from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = actor_user_id
      and membership.is_active
      and membership.role in ('admin'::public.app_role, 'gestor'::public.app_role)
  ) then
    raise exception 'purchase_order_not_authorized';
  end if;

  select * into current_po from public.purchase_orders
  where id = target_purchase_order_id and organization_id = target_organization_id
  for update;

  if current_po.id is null then raise exception 'purchase_order_not_found'; end if;
  if current_po.version <> expected_version then raise exception 'stale_purchase_order'; end if;
  if current_po.status <> 'draft' then raise exception 'purchase_order_not_draft'; end if;
  if current_po.supplier_id is null then raise exception 'purchase_order_supplier_required'; end if;

  select count(*) into item_count from public.purchase_order_items where purchase_order_id = target_purchase_order_id;
  if item_count = 0 then raise exception 'purchase_order_requires_items'; end if;

  update public.purchase_orders set
    status = 'approved', approved_at = now(), approved_by = actor_user_id, version = version + 1
  where id = target_purchase_order_id;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (target_organization_id, target_purchase_order_id, 'approved', actor_user_id, '{}'::jsonb);

  return current_po.version + 1;
end;
$$;

create or replace function public.reopen_purchase_order(
  target_organization_id uuid,
  actor_user_id uuid,
  target_purchase_order_id uuid,
  expected_version integer
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  current_po public.purchase_orders%rowtype;
begin
  if not exists (
    select 1 from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = actor_user_id
      and membership.is_active
      and membership.role in ('admin'::public.app_role, 'gestor'::public.app_role)
  ) then
    raise exception 'purchase_order_not_authorized';
  end if;

  select * into current_po from public.purchase_orders
  where id = target_purchase_order_id and organization_id = target_organization_id
  for update;

  if current_po.id is null then raise exception 'purchase_order_not_found'; end if;
  if current_po.version <> expected_version then raise exception 'stale_purchase_order'; end if;
  if current_po.status <> 'approved' then raise exception 'purchase_order_not_approved'; end if;

  update public.purchase_orders set
    status = 'draft', approved_at = null, approved_by = null, version = version + 1
  where id = target_purchase_order_id;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (target_organization_id, target_purchase_order_id, 'reopened', actor_user_id, '{}'::jsonb);

  return current_po.version + 1;
end;
$$;

create or replace function public.mark_purchase_order_ordered(
  target_organization_id uuid,
  actor_user_id uuid,
  target_purchase_order_id uuid,
  expected_version integer,
  destination_warehouse_key text,
  destination_warehouse_name text,
  transit_accounting_source text default 'internal',
  expected_at timestamptz default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  current_po public.purchase_orders%rowtype;
  resolved_expected_at timestamptz;
  max_lead_time_days integer;
begin
  if not exists (
    select 1 from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = actor_user_id
      and membership.is_active
      and membership.role in ('admin'::public.app_role, 'gestor'::public.app_role)
  ) then
    raise exception 'purchase_order_not_authorized';
  end if;

  if transit_accounting_source not in ('internal', 'upseller_confirmed') then
    raise exception 'invalid_transit_accounting_source';
  end if;

  if nullif(btrim(destination_warehouse_key), '') is null or nullif(btrim(destination_warehouse_name), '') is null then
    raise exception 'purchase_order_destination_required';
  end if;

  select * into current_po from public.purchase_orders
  where id = target_purchase_order_id and organization_id = target_organization_id
  for update;

  if current_po.id is null then raise exception 'purchase_order_not_found'; end if;
  if current_po.version <> expected_version then raise exception 'stale_purchase_order'; end if;
  if current_po.status <> 'approved' then raise exception 'purchase_order_not_approved'; end if;

  resolved_expected_at := expected_at;

  if resolved_expected_at is null then
    select max(lead_time_days_snapshot) into max_lead_time_days
    from public.purchase_order_items where purchase_order_id = target_purchase_order_id;

    resolved_expected_at := now() + make_interval(days => coalesce(max_lead_time_days, 15));
  end if;

  update public.purchase_orders set
    status = 'ordered',
    ordered_at = now(),
    ordered_by = actor_user_id,
    destination_warehouse_key = mark_purchase_order_ordered.destination_warehouse_key,
    destination_warehouse_name = mark_purchase_order_ordered.destination_warehouse_name,
    transit_accounting_source = mark_purchase_order_ordered.transit_accounting_source,
    expected_at = resolved_expected_at,
    version = version + 1
  where id = target_purchase_order_id;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (target_organization_id, target_purchase_order_id, 'ordered', actor_user_id,
    jsonb_build_object('transitAccountingSource', transit_accounting_source, 'expectedAt', resolved_expected_at));

  return jsonb_build_object('version', current_po.version + 1, 'expectedAt', resolved_expected_at);
end;
$$;

create or replace function public.change_purchase_order_transit_accounting(
  target_organization_id uuid,
  actor_user_id uuid,
  target_purchase_order_id uuid,
  expected_version integer,
  transit_accounting_source text
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  current_po public.purchase_orders%rowtype;
begin
  if not exists (
    select 1 from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = actor_user_id
      and membership.is_active
      and membership.role in ('admin'::public.app_role, 'gestor'::public.app_role)
  ) then
    raise exception 'purchase_order_not_authorized';
  end if;

  if transit_accounting_source not in ('internal', 'upseller_confirmed') then
    raise exception 'invalid_transit_accounting_source';
  end if;

  select * into current_po from public.purchase_orders
  where id = target_purchase_order_id and organization_id = target_organization_id
  for update;

  if current_po.id is null then raise exception 'purchase_order_not_found'; end if;
  if current_po.version <> expected_version then raise exception 'stale_purchase_order'; end if;
  if current_po.status not in ('ordered', 'partially_received') then
    raise exception 'purchase_order_not_in_transit';
  end if;

  update public.purchase_orders set
    transit_accounting_source = change_purchase_order_transit_accounting.transit_accounting_source,
    version = version + 1
  where id = target_purchase_order_id;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (target_organization_id, target_purchase_order_id, 'transit_accounting_changed', actor_user_id,
    jsonb_build_object('from', current_po.transit_accounting_source, 'to', transit_accounting_source));

  return current_po.version + 1;
end;
$$;

create or replace function public.cancel_purchase_order(
  target_organization_id uuid,
  actor_user_id uuid,
  target_purchase_order_id uuid,
  expected_version integer
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  current_po public.purchase_orders%rowtype;
begin
  if not exists (
    select 1 from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = actor_user_id
      and membership.is_active
      and membership.role in ('admin'::public.app_role, 'gestor'::public.app_role)
  ) then
    raise exception 'purchase_order_not_authorized';
  end if;

  select * into current_po from public.purchase_orders
  where id = target_purchase_order_id and organization_id = target_organization_id
  for update;

  if current_po.id is null then raise exception 'purchase_order_not_found'; end if;
  if current_po.version <> expected_version then raise exception 'stale_purchase_order'; end if;
  if current_po.status in ('received', 'cancelled') then raise exception 'purchase_order_not_cancellable'; end if;

  if exists (
    select 1 from public.purchase_order_item_progress
    where purchase_order_id = target_purchase_order_id and received_quantity > 0
  ) then
    raise exception 'purchase_order_has_receipts';
  end if;

  update public.purchase_orders set
    status = 'cancelled', cancelled_at = now(), cancelled_by = actor_user_id, version = version + 1
  where id = target_purchase_order_id;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (target_organization_id, target_purchase_order_id, 'cancelled', actor_user_id, '{}'::jsonb);

  return current_po.version + 1;
end;
$$;

create or replace function public.cancel_purchase_order_item_remaining(
  target_organization_id uuid,
  actor_user_id uuid,
  target_purchase_order_id uuid,
  expected_version integer,
  target_purchase_order_item_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  current_po public.purchase_orders%rowtype;
  item_progress public.purchase_order_item_progress%rowtype;
  all_complete boolean;
  new_status text;
begin
  if not exists (
    select 1 from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = actor_user_id
      and membership.is_active
      and membership.role in ('admin'::public.app_role, 'gestor'::public.app_role)
  ) then
    raise exception 'purchase_order_not_authorized';
  end if;

  select * into current_po from public.purchase_orders
  where id = target_purchase_order_id and organization_id = target_organization_id
  for update;

  if current_po.id is null then raise exception 'purchase_order_not_found'; end if;
  if current_po.version <> expected_version then raise exception 'stale_purchase_order'; end if;
  if current_po.status not in ('ordered', 'partially_received') then
    raise exception 'purchase_order_not_in_transit';
  end if;

  select * into item_progress from public.purchase_order_item_progress
  where purchase_order_item_id = target_purchase_order_item_id and purchase_order_id = target_purchase_order_id;

  if item_progress.purchase_order_item_id is null then raise exception 'purchase_order_item_not_found'; end if;

  update public.purchase_order_items set
    cancelled_quantity = quantity_ordered - item_progress.received_quantity
  where id = target_purchase_order_item_id;

  select bool_and(received_quantity + cancelled_quantity >= quantity_ordered)
  into all_complete
  from public.purchase_order_item_progress
  where purchase_order_id = target_purchase_order_id;

  new_status := case when all_complete then 'received' else current_po.status end;

  update public.purchase_orders set status = new_status, version = version + 1
  where id = target_purchase_order_id;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (target_organization_id, target_purchase_order_id, 'remaining_cancelled', actor_user_id,
    jsonb_build_object('purchaseOrderItemId', target_purchase_order_item_id,
      'previousStatus', current_po.status, 'newStatus', new_status));

  return jsonb_build_object('version', current_po.version + 1, 'status', new_status);
end;
$$;

revoke all on function public.create_supplier(uuid, uuid, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.update_supplier(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.create_blank_purchase_order(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.create_purchase_order_from_planning(uuid, uuid, text[], text, text, text) from public, anon, authenticated;
revoke all on function public.update_purchase_order_draft(uuid, uuid, uuid, integer, uuid, text, text, text, timestamptz, boolean, boolean) from public, anon, authenticated;
revoke all on function public.upsert_purchase_order_item(uuid, uuid, uuid, integer, text, numeric, numeric, boolean) from public, anon, authenticated;
revoke all on function public.remove_purchase_order_item(uuid, uuid, uuid, integer, uuid) from public, anon, authenticated;
revoke all on function public.upsert_supplier_product_link(uuid, uuid, uuid, text, text, text, boolean, numeric, boolean) from public, anon, authenticated;
revoke all on function public.approve_purchase_order(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.reopen_purchase_order(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.mark_purchase_order_ordered(uuid, uuid, uuid, integer, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.change_purchase_order_transit_accounting(uuid, uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.cancel_purchase_order(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.cancel_purchase_order_item_remaining(uuid, uuid, uuid, integer, uuid) from public, anon, authenticated;

grant execute on function public.create_supplier(uuid, uuid, text, text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.update_supplier(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, boolean) to service_role;
grant execute on function public.create_blank_purchase_order(uuid, uuid, text) to service_role;
grant execute on function public.create_purchase_order_from_planning(uuid, uuid, text[], text, text, text) to service_role;
grant execute on function public.update_purchase_order_draft(uuid, uuid, uuid, integer, uuid, text, text, text, timestamptz, boolean, boolean) to service_role;
grant execute on function public.upsert_purchase_order_item(uuid, uuid, uuid, integer, text, numeric, numeric, boolean) to service_role;
grant execute on function public.remove_purchase_order_item(uuid, uuid, uuid, integer, uuid) to service_role;
grant execute on function public.upsert_supplier_product_link(uuid, uuid, uuid, text, text, text, boolean, numeric, boolean) to service_role;
grant execute on function public.approve_purchase_order(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.reopen_purchase_order(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.mark_purchase_order_ordered(uuid, uuid, uuid, integer, text, text, text, timestamptz) to service_role;
grant execute on function public.change_purchase_order_transit_accounting(uuid, uuid, uuid, integer, text) to service_role;
grant execute on function public.cancel_purchase_order(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.cancel_purchase_order_item_remaining(uuid, uuid, uuid, integer, uuid) to service_role;
