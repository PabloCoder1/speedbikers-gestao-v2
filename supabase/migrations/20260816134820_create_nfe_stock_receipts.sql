-- Stock receipts imported from an authorized NF-e XML.
--
-- The UpSeller stock state remains the authoritative baseline. Receipt items
-- are stored as auditable deltas tied to the exact import that was current at
-- confirmation time. A later complete UpSeller import automatically
-- supersedes those deltas, preventing the same receipt from being counted
-- twice after reconciliation.

create table public.stock_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_type text not null default 'nfe_xml' check (source_type = 'nfe_xml'),
  access_key text not null check (access_key ~ '^[0-9]{44}$'),
  invoice_number text not null,
  invoice_series text,
  issued_at timestamptz,
  protocol_status text not null,
  supplier_name text,
  supplier_document text,
  recipient_document text,
  total_amount numeric check (total_amount is null or total_amount >= 0),
  destination_warehouse_name text not null,
  destination_warehouse_key text not null,
  source_sha256 text not null check (char_length(source_sha256) = 64),
  status text not null default 'applied' check (status = 'applied'),
  received_by uuid not null references auth.users(id) on delete restrict,
  applied_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (organization_id, access_key),
  unique (organization_id, source_sha256)
);

create index stock_receipts_recent_idx
on public.stock_receipts (organization_id, applied_at desc);

create table public.stock_receipt_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  receipt_id uuid not null references public.stock_receipts(id) on delete cascade,
  line_number integer not null check (line_number > 0),
  product_id uuid references public.products(id) on delete set null,
  source_sku text not null,
  sku_key text not null,
  description text,
  unit text,
  quantity numeric not null check (quantity > 0),
  unit_value numeric check (unit_value is null or unit_value >= 0),
  total_value numeric check (total_value is null or total_value >= 0),
  baseline_stock_state_id uuid references public.upseller_stock_states(id) on delete set null,
  baseline_import_id uuid not null references public.upseller_import_batches(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (receipt_id, line_number)
);

create index stock_receipt_items_effective_idx
on public.stock_receipt_items (
  organization_id,
  sku_key,
  baseline_import_id
);

alter table public.stock_receipts enable row level security;
alter table public.stock_receipt_items enable row level security;

create policy stock_receipts_member_select
on public.stock_receipts
for select
to authenticated
using (private.is_organization_member(organization_id));

create policy stock_receipt_items_member_select
on public.stock_receipt_items
for select
to authenticated
using (private.is_organization_member(organization_id));

create view public.current_stock_receipt_adjustments
with (security_invoker = true)
as
select
  item.organization_id,
  item.receipt_id,
  item.product_id,
  item.source_sku,
  item.sku_key,
  receipt.destination_warehouse_name as warehouse_name,
  receipt.destination_warehouse_key as warehouse_key,
  item.quantity,
  item.unit_value,
  item.total_value,
  item.baseline_import_id,
  receipt.applied_at
from public.stock_receipt_items as item
join public.stock_receipts as receipt
  on receipt.id = item.receipt_id
 and receipt.organization_id = item.organization_id
join public.upseller_stock_states as state
  on state.organization_id = item.organization_id
 and state.sku_key = item.sku_key
 and state.warehouse_key = receipt.destination_warehouse_key
 and state.source_import_id = item.baseline_import_id
where receipt.status = 'applied';

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
    received_by
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
    target_received_by
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
      baseline_import_id
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
      current_state.source_import_id
    );
  end loop;

  return created_receipt_id;
end;
$$;

revoke all on public.stock_receipts from public, anon;
revoke all on public.stock_receipt_items from public, anon;
revoke all on public.current_stock_receipt_adjustments from public, anon;

grant select on public.stock_receipts to authenticated;
grant select on public.stock_receipt_items to authenticated;
grant select on public.current_stock_receipt_adjustments to authenticated;

grant all on public.stock_receipts to service_role;
grant all on public.stock_receipt_items to service_role;
grant select on public.current_stock_receipt_adjustments to service_role;

revoke all on function public.apply_nfe_stock_receipt(uuid, uuid, jsonb, jsonb)
from public, anon, authenticated;

grant execute on function public.apply_nfe_stock_receipt(uuid, uuid, jsonb, jsonb)
to service_role;
