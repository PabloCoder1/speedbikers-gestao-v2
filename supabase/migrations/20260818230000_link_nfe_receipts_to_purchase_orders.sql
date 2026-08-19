-- Extend apply_nfe_stock_receipt (originally defined in
-- 20260816134820_create_nfe_stock_receipts.sql, not touched here) to
-- optionally link a receipt to a purchase order. stock_receipts.purchase_order_id
-- and stock_receipt_items.purchase_order_item_id already exist (added in
-- 20260818201926_create_purchase_orders_schema.sql) but nothing populated
-- or validated them yet — this is the missing piece.
--
-- purchaseOrderId/purchaseOrderItemId are optional inside the existing
-- jsonb payloads, so the function signature is unchanged and a plain
-- NF-e receipt with no purchase order keeps working exactly as before.
-- Everything is re-validated here — the preview/commit routes never get
-- to assert anything the database doesn't check again.

create or replace function public.apply_nfe_stock_receipt(
  target_organization_id uuid,
  target_received_by uuid,
  receipt_payload jsonb,
  items_payload jsonb
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  created_receipt_id uuid;
  item_payload jsonb;
  item_quantity numeric;
  item_unit_value numeric;
  item_total_value numeric;
  item_line_number integer;
  item_product_id uuid;
  item_sku_key text;
  expected_baseline_import_id uuid;
  current_state public.upseller_stock_states%rowtype;
  target_purchase_order_id uuid;
  purchase_order_row public.purchase_orders%rowtype;
  item_purchase_order_item_id uuid;
  purchase_order_item_row public.purchase_order_items%rowtype;
  linked_item_count integer := 0;
  linked_total_quantity numeric := 0;
  all_complete boolean;
  new_po_status text;
begin
  if not exists (
    select 1
    from public.organization_members as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = target_received_by
      and membership.is_active
      and membership.role in (
        'admin'::public.app_role,
        'gestor'::public.app_role,
        'operador'::public.app_role
      )
  ) then
    raise exception 'stock_receipt_not_authorized';
  end if;

  if jsonb_typeof(receipt_payload) <> 'object'
    or jsonb_typeof(items_payload) <> 'array'
    or jsonb_array_length(items_payload) = 0
    or jsonb_array_length(items_payload) > 500
  then
    raise exception 'invalid_stock_receipt_payload';
  end if;

  if coalesce(receipt_payload ->> 'accessKey', '') !~ '^[0-9]{44}$'
    or coalesce(receipt_payload ->> 'sourceSha256', '') !~ '^[0-9a-f]{64}$'
    or nullif(btrim(receipt_payload ->> 'invoiceNumber'), '') is null
    or nullif(btrim(receipt_payload ->> 'warehouseKey'), '') is null
    or nullif(btrim(receipt_payload ->> 'warehouseName'), '') is null
  then
    raise exception 'invalid_stock_receipt_header';
  end if;

  target_purchase_order_id := nullif(receipt_payload ->> 'purchaseOrderId', '')::uuid;

  if target_purchase_order_id is not null then
    select * into purchase_order_row
    from public.purchase_orders
    where id = target_purchase_order_id
      and organization_id = target_organization_id
    for update;

    if purchase_order_row.id is null then
      raise exception 'purchase_order_not_found';
    end if;

    if purchase_order_row.status not in ('ordered', 'partially_received') then
      raise exception 'purchase_order_not_receivable';
    end if;
  end if;

  insert into public.stock_receipts (
    organization_id,
    access_key,
    invoice_number,
    invoice_series,
    issued_at,
    protocol_status,
    supplier_name,
    supplier_document,
    recipient_document,
    total_amount,
    destination_warehouse_name,
    destination_warehouse_key,
    source_sha256,
    received_by,
    purchase_order_id
  ) values (
    target_organization_id,
    receipt_payload ->> 'accessKey',
    receipt_payload ->> 'invoiceNumber',
    nullif(btrim(receipt_payload ->> 'invoiceSeries'), ''),
    nullif(receipt_payload ->> 'issuedAt', '')::timestamptz,
    receipt_payload ->> 'protocolStatus',
    nullif(btrim(receipt_payload ->> 'supplierName'), ''),
    nullif(btrim(receipt_payload ->> 'supplierDocument'), ''),
    nullif(btrim(receipt_payload ->> 'recipientDocument'), ''),
    nullif(receipt_payload ->> 'totalAmount', '')::numeric,
    receipt_payload ->> 'warehouseName',
    receipt_payload ->> 'warehouseKey',
    receipt_payload ->> 'sourceSha256',
    target_received_by,
    target_purchase_order_id
  )
  returning id into created_receipt_id;

  for item_payload in
    select value from jsonb_array_elements(items_payload)
  loop
    item_line_number := nullif(item_payload ->> 'lineNumber', '')::integer;
    item_product_id := nullif(item_payload ->> 'productId', '')::uuid;
    item_sku_key := nullif(btrim(item_payload ->> 'skuKey'), '');
    item_quantity := nullif(item_payload ->> 'quantity', '')::numeric;
    item_unit_value := nullif(item_payload ->> 'unitValue', '')::numeric;
    item_total_value := nullif(item_payload ->> 'totalValue', '')::numeric;
    expected_baseline_import_id := nullif(item_payload ->> 'baselineImportId', '')::uuid;
    item_purchase_order_item_id := nullif(item_payload ->> 'purchaseOrderItemId', '')::uuid;

    if item_line_number is null
      or item_line_number <= 0
      or item_product_id is null
      or item_sku_key is null
      or item_quantity is null
      or item_quantity <= 0
      or item_quantity > 1000000000
      or expected_baseline_import_id is null
      or (item_unit_value is not null and item_unit_value < 0)
      or (item_total_value is not null and item_total_value < 0)
    then
      raise exception 'invalid_stock_receipt_item';
    end if;

    select state.* into current_state
    from public.upseller_stock_states as state
    where state.organization_id = target_organization_id
      and state.sku_key = item_sku_key
      and state.warehouse_key = receipt_payload ->> 'warehouseKey'
    for share;

    if current_state.id is null then
      raise exception 'stock_receipt_state_not_found';
    end if;

    if current_state.source_import_id <> expected_baseline_import_id then
      raise exception 'stock_changed_since_receipt_preview';
    end if;

    if not exists (
      select 1
      from public.product_inventory_links as link
      where link.organization_id = target_organization_id
        and link.product_id = item_product_id
        and link.source = 'upseller'
        and link.source_sku_key = item_sku_key
        and link.is_active
    ) then
      raise exception 'stock_receipt_product_link_not_found';
    end if;

    if item_purchase_order_item_id is not null then
      if target_purchase_order_id is null then
        raise exception 'purchase_order_item_requires_purchase_order';
      end if;

      select * into purchase_order_item_row
      from public.purchase_order_items
      where id = item_purchase_order_item_id
        and purchase_order_id = target_purchase_order_id
        and organization_id = target_organization_id;

      if purchase_order_item_row.id is null or purchase_order_item_row.source_sku_key <> item_sku_key then
        raise exception 'purchase_order_item_mismatch';
      end if;

      linked_item_count := linked_item_count + 1;
      linked_total_quantity := linked_total_quantity + item_quantity;
    end if;

    insert into public.stock_receipt_items (
      organization_id,
      receipt_id,
      line_number,
      product_id,
      source_sku,
      sku_key,
      description,
      unit,
      quantity,
      unit_value,
      total_value,
      baseline_stock_state_id,
      baseline_import_id,
      purchase_order_item_id
    ) values (
      target_organization_id,
      created_receipt_id,
      item_line_number,
      item_product_id,
      current_state.source_sku,
      item_sku_key,
      nullif(btrim(item_payload ->> 'description'), ''),
      nullif(btrim(item_payload ->> 'unit'), ''),
      item_quantity,
      item_unit_value,
      item_total_value,
      current_state.id,
      current_state.source_import_id,
      item_purchase_order_item_id
    );
  end loop;

  -- Only touch PO status/events if this receipt actually matched at least
  -- one of its items — a receipt tagged with a purchaseOrderId whose lines
  -- don't match anything (wrong PO selected, or a fully "extra" invoice)
  -- must not force ordered -> partially_received with nothing received.
  if target_purchase_order_id is not null and linked_item_count > 0 then
    -- Same "all outstanding settled -> received" rule as
    -- cancel_purchase_order_item_remaining: over-delivery is allowed and
    -- never blocking, outstanding just floors at zero via the view.
    -- linked_item_count > 0 guarantees at least one item now has a
    -- positive received quantity, so "not all complete" here always means
    -- partially_received, never a false transition out of ordered.
    select bool_and(received_quantity + cancelled_quantity >= quantity_ordered)
    into all_complete
    from public.purchase_order_item_progress
    where purchase_order_id = target_purchase_order_id;

    new_po_status := case when all_complete then 'received' else 'partially_received' end;

    update public.purchase_orders
    set status = new_po_status, version = version + 1
    where id = target_purchase_order_id;

    insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
    values (
      target_organization_id,
      target_purchase_order_id,
      'receipt_linked',
      target_received_by,
      jsonb_build_object(
        'receiptId', created_receipt_id,
        'itemCount', linked_item_count,
        'totalQuantity', linked_total_quantity,
        'newStatus', new_po_status
      )
    );
  end if;

  return created_receipt_id;
end;
$$;
