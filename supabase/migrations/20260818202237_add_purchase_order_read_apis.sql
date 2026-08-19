-- Purchase order read RPCs backing /pedidos-compra and the
-- "open order" context on /compras. security definer + explicit
-- private.is_organization_member(...) check (same shape as
-- get_purchase_planning_summary/_page), granted to authenticated.

create or replace function public.get_open_purchase_orders_by_sku(
  target_organization_id uuid,
  source_sku_keys text[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not private.is_organization_member(target_organization_id) then
    raise exception 'not_authorized';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'sourceSkuKey', item.source_sku_key,
    'purchaseOrderId', po.id,
    'orderNumber', 'PC-' || lpad(po.order_number::text, 6, '0'),
    'status', po.status
  )), '[]'::jsonb)
  into result
  from public.purchase_order_items as item
  join public.purchase_orders as po on po.id = item.purchase_order_id
  where po.organization_id = target_organization_id
    and po.status in ('draft', 'approved', 'ordered', 'partially_received')
    and item.source_sku_key = any(source_sku_keys);

  return result;
end;
$$;

create or replace function public.get_purchase_orders_summary(
  target_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not private.is_organization_member(target_organization_id) then
    raise exception 'not_authorized';
  end if;

  with po_totals as materialized (
    select
      po.id,
      po.status,
      po.expected_at,
      coalesce(sum((item.quantity_ordered - item.cancelled_quantity) * coalesce(item.unit_cost, 0)), 0) as open_value,
      bool_or(progress.outstanding_quantity > 0) as has_outstanding
    from public.purchase_orders as po
    left join public.purchase_order_items as item on item.purchase_order_id = po.id
    left join public.purchase_order_item_progress as progress on progress.purchase_order_item_id = item.id
    where po.organization_id = target_organization_id
    group by po.id, po.status, po.expected_at
  )
  select jsonb_build_object(
    'drafts', count(*) filter (where status = 'draft'),
    'awaitingApproval', count(*) filter (where status = 'approved'),
    'inTransit', count(*) filter (where status in ('ordered', 'partially_received')),
    'overdue', count(*) filter (
      where status in ('ordered', 'partially_received')
        and expected_at is not null and expected_at < now()
        and has_outstanding
    ),
    'receivedInPeriod', (
      select count(distinct receipt.purchase_order_id)
      from public.stock_receipts as receipt
      where receipt.organization_id = target_organization_id
        and receipt.purchase_order_id is not null
        and receipt.applied_at >= now() - interval '30 days'
    ),
    'openValue', coalesce(sum(open_value) filter (where status in ('draft', 'approved', 'ordered', 'partially_received')), 0)
  )
  into result
  from po_totals;

  return result;
end;
$$;

create or replace function public.get_purchase_orders_page(
  target_organization_id uuid,
  search_query text default '',
  status_filter text default 'all',
  result_limit integer default 100,
  result_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  safe_limit integer := least(greatest(coalesce(result_limit, 100), 1), 100);
  safe_offset integer := least(greatest(coalesce(result_offset, 0), 0), 100000);
  safe_status text := lower(btrim(coalesce(status_filter, 'all')));
  normalized_search text := lower(btrim(coalesce(search_query, '')));
  result jsonb;
begin
  if not private.is_organization_member(target_organization_id) then
    raise exception 'not_authorized';
  end if;

  if safe_status not in ('all', 'draft', 'approved', 'ordered', 'partially_received', 'overdue', 'received', 'cancelled') then
    raise exception 'invalid_purchase_order_filter';
  end if;

  with po_stats as materialized (
    select
      po.id as purchase_order_id,
      po.order_number,
      po.status,
      po.ordered_at,
      po.expected_at,
      supplier.name as supplier_name,
      count(item.id) as item_count,
      coalesce(sum(item.quantity_ordered), 0) as units_ordered,
      coalesce(sum(progress.received_quantity), 0) as units_received,
      coalesce(sum(progress.outstanding_quantity), 0) as units_outstanding,
      coalesce(sum(item.quantity_ordered * coalesce(item.unit_cost, 0)), 0) as total_value,
      coalesce(array_agg(distinct item.source_sku) filter (where item.source_sku is not null), array[]::text[]) as skus
    from public.purchase_orders as po
    left join public.suppliers as supplier on supplier.id = po.supplier_id
    left join public.purchase_order_items as item on item.purchase_order_id = po.id
    left join public.purchase_order_item_progress as progress on progress.purchase_order_item_id = item.id
    where po.organization_id = target_organization_id
    group by po.id, po.order_number, po.status, po.ordered_at, po.expected_at, supplier.name
  ),
  matching as materialized (
    select stats.*,
      (stats.status in ('ordered', 'partially_received')
        and stats.expected_at is not null and stats.expected_at < now()
        and stats.units_outstanding > 0) as overdue,
      count(*) over ()::bigint as match_count
    from po_stats as stats
    where (
      normalized_search = ''
      or position(normalized_search in lower('pc-' || lpad(stats.order_number::text, 6, '0'))) > 0
      or position(normalized_search in lower(coalesce(stats.supplier_name, ''))) > 0
      or exists (select 1 from unnest(stats.skus) as sku where position(normalized_search in lower(sku)) > 0)
    )
    and (
      safe_status = 'all'
      or (safe_status = 'overdue' and (stats.status in ('ordered', 'partially_received')
            and stats.expected_at is not null and stats.expected_at < now() and stats.units_outstanding > 0))
      or (safe_status <> 'overdue' and stats.status = safe_status)
    )
  ),
  selected as materialized (
    select * from matching
    order by
      case status when 'draft' then 1 when 'approved' then 2 when 'ordered' then 3
        when 'partially_received' then 4 when 'received' then 5 else 6 end,
      ordered_at desc nulls last,
      order_number desc
    limit safe_limit offset safe_offset
  )
  select jsonb_build_object(
    'matchCount', coalesce((select max(match_count) from matching), 0),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'purchaseOrderId', selected.purchase_order_id,
        'orderNumber', 'PC-' || lpad(selected.order_number::text, 6, '0'),
        'supplierName', selected.supplier_name,
        'status', selected.status,
        'itemCount', selected.item_count,
        'unitsOrdered', selected.units_ordered,
        'unitsReceived', selected.units_received,
        'unitsOutstanding', selected.units_outstanding,
        'totalValue', selected.total_value,
        'orderedAt', selected.ordered_at,
        'expectedAt', selected.expected_at,
        'overdue', selected.overdue
      ))
      from selected
    ), '[]'::jsonb)
  )
  into result;

  return result;
end;
$$;

create or replace function public.get_purchase_order_detail(
  target_organization_id uuid,
  target_purchase_order_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
  header jsonb;
  items jsonb;
  events jsonb;
  receipts jsonb;
begin
  if not private.is_organization_member(target_organization_id) then
    raise exception 'not_authorized';
  end if;

  select jsonb_build_object(
    'purchaseOrderId', po.id,
    'orderNumber', 'PC-' || lpad(po.order_number::text, 6, '0'),
    'status', po.status,
    'transitAccountingSource', po.transit_accounting_source,
    'supplierId', po.supplier_id,
    'supplierName', supplier.name,
    'supplierDocument', supplier.document,
    'destinationWarehouseKey', po.destination_warehouse_key,
    'destinationWarehouseName', po.destination_warehouse_name,
    'currency', po.currency,
    'notes', po.notes,
    'expectedAt', po.expected_at,
    'approvedAt', po.approved_at,
    'orderedAt', po.ordered_at,
    'cancelledAt', po.cancelled_at,
    'createdAt', po.created_at,
    'version', po.version
  )
  into header
  from public.purchase_orders as po
  left join public.suppliers as supplier on supplier.id = po.supplier_id
  where po.id = target_purchase_order_id and po.organization_id = target_organization_id;

  if header is null then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'purchaseOrderItemId', item.id,
    'sourceSku', item.source_sku,
    'sourceSkuKey', item.source_sku_key,
    'titleSnapshot', item.title_snapshot,
    'brandSnapshot', item.brand_snapshot,
    'quantityOrdered', item.quantity_ordered,
    'cancelledQuantity', item.cancelled_quantity,
    'unitCost', item.unit_cost,
    'receivedQuantity', progress.received_quantity,
    'outstandingQuantity', progress.outstanding_quantity,
    'overReceivedQuantity', progress.over_received_quantity,
    'suggestedQuantitySnapshot', item.suggested_quantity_snapshot,
    'physicalAvailableSnapshot', item.physical_available_snapshot,
    'upsellerPurchaseInTransitSnapshot', item.upseller_purchase_in_transit_snapshot,
    'avgDailySales30Snapshot', item.avg_daily_sales_30_snapshot,
    'leadTimeDaysSnapshot', item.lead_time_days_snapshot,
    'lowStockThresholdSnapshot', item.low_stock_threshold_snapshot,
    'projectedStockAtArrivalSnapshot', item.projected_stock_at_arrival_snapshot,
    'planningStatusSnapshot', item.planning_status_snapshot,
    'planningGeneratedAt', item.planning_generated_at
  ) order by item.created_at), '[]'::jsonb)
  into items
  from public.purchase_order_items as item
  left join public.purchase_order_item_progress as progress on progress.purchase_order_item_id = item.id
  where item.purchase_order_id = target_purchase_order_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'eventType', event.event_type,
    'actorUserId', event.actor_user_id,
    'metadata', event.metadata,
    'createdAt', event.created_at
  ) order by event.created_at desc), '[]'::jsonb)
  into events
  from public.purchase_order_events as event
  where event.purchase_order_id = target_purchase_order_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'receiptId', receipt.id,
    'invoiceNumber', receipt.invoice_number,
    'appliedAt', receipt.applied_at,
    'totalAmount', receipt.total_amount,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'sourceSku', ri.source_sku,
        'skuKey', ri.sku_key,
        'quantity', ri.quantity,
        'unitValue', ri.unit_value,
        'totalValue', ri.total_value
      )), '[]'::jsonb)
      from public.stock_receipt_items as ri
      where ri.receipt_id = receipt.id
    )
  ) order by receipt.applied_at desc), '[]'::jsonb)
  into receipts
  from public.stock_receipts as receipt
  where receipt.purchase_order_id = target_purchase_order_id;

  result := header || jsonb_build_object('items', items, 'events', events, 'receipts', receipts);

  return result;
end;
$$;

revoke all on function public.get_open_purchase_orders_by_sku(uuid, text[]) from public, anon;
revoke all on function public.get_purchase_orders_summary(uuid) from public, anon;
revoke all on function public.get_purchase_orders_page(uuid, text, text, integer, integer) from public, anon;
revoke all on function public.get_purchase_order_detail(uuid, uuid) from public, anon;

grant execute on function public.get_open_purchase_orders_by_sku(uuid, text[]) to authenticated;
grant execute on function public.get_purchase_orders_summary(uuid) to authenticated;
grant execute on function public.get_purchase_orders_page(uuid, text, text, integer, integer) to authenticated;
grant execute on function public.get_purchase_order_detail(uuid, uuid) to authenticated;
