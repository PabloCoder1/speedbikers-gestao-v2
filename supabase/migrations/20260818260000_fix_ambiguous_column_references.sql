-- Smoke-testing the recovered RPCs (rolled-back transactions against
-- production, zero rows left behind) surfaced a systemic bug: several
-- functions compare/assign a bare column name that is also one of the
-- function's own parameter names. PL/pgSQL's default
-- (plpgsql.variable_conflict = error) raises "column reference ... is
-- ambiguous" for any such bare reference, so these code paths would fail
-- at runtime for every real caller:
--
--   - upsert_purchase_order_item: the "does this SKU already have an
--     item on this PO" lookup and the planning-signal lookup both
--     compared the bare `source_sku_key` column against the identically
--     named parameter.
--   - upsert_supplier_product_link: the "demote the previous preferred
--     link" UPDATE compared bare `source_sku_key`/`supplier_id` against
--     the identically named parameters.
--   - update_purchase_order_draft: every SET assignment's fallback
--     (`coalesce(supplier_id, current_po.supplier_id)` etc.) read the
--     bare parameter name, which collides with the column of the same
--     name being updated.
--
-- Fix: qualify every parameter reference with the function name (the
-- existing convention already used correctly elsewhere in these same
-- functions, e.g. mark_purchase_order_ordered), or with a table alias
-- for the column side. No behavior changes — same logic, now resolvable.

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

  select * into existing_item from public.purchase_order_items as poi
  where poi.purchase_order_id = target_purchase_order_id
    and poi.source_sku_key = upsert_purchase_order_item.source_sku_key;

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
    from private.get_purchase_planning_signals(target_organization_id) as signals
    where signals.source_sku_key = upsert_purchase_order_item.source_sku_key
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
      update public.supplier_product_links as spl set is_preferred = false
      where spl.organization_id = target_organization_id
        and spl.source_sku_key = upsert_supplier_product_link.source_sku_key
        and spl.supplier_id = current_preferred_supplier_id;
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

create or replace function public.update_purchase_order_draft(
  target_organization_id uuid,
  actor_user_id uuid,
  target_purchase_order_id uuid,
  expected_version integer,
  supplier_id uuid default null,
  destination_warehouse_key text default null,
  destination_warehouse_name text default null,
  notes text default null,
  expected_at timestamp with time zone default null,
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
    supplier_id = coalesce(update_purchase_order_draft.supplier_id, current_po.supplier_id),
    destination_warehouse_key = coalesce(update_purchase_order_draft.destination_warehouse_key, current_po.destination_warehouse_key),
    destination_warehouse_name = coalesce(update_purchase_order_draft.destination_warehouse_name, current_po.destination_warehouse_name),
    notes = case when clear_notes then null else coalesce(update_purchase_order_draft.notes, current_po.notes) end,
    expected_at = case when clear_expected_at then null else coalesce(update_purchase_order_draft.expected_at, current_po.expected_at) end,
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
