-- ============================================================
-- ETAPA 34 — Pedidos de Venda V1
--
-- Read-only workspace on top of the existing public.orders /
-- public.order_items tables (ingested by persist-orders-batch.ts via
-- orders_v2 + orders_recent, untouched here). No new ingestion, no
-- writes to Mercado Livre, no new tables.
--
-- Every RPC below is intentionally NOT `security definer` — it runs
-- as the calling authenticated user (invoker mode), so the existing
-- RLS policies on orders/order_items/daily_product_metrics
-- ("... using (private.can_access_ml_account(ml_account_id))")
-- enforce per-account read permission automatically. This is safer
-- than hand-rolling the same check: a row the caller cannot see is
-- simply invisible to the query, so it can never leak into an
-- aggregate or a detail response. `private.is_organization_member`
-- is still called explicitly for a clean 'not_authorized' error and
-- to scope every query by organization_id defensively.
--
-- Each function also accepts a service_role caller (same
-- `caller_role = 'service_role'` bypass pattern already used by
-- get_purchase_planning_signals/get_purchase_planning_validation_sample)
-- so the credentialed test suite can call them without a real user
-- session. Called this way the org-membership gate is bypassed, but
-- RLS itself is NOT (service_role bypasses RLS by its own, separate,
-- pre-existing Postgres/Supabase convention) — this only affects
-- which callers can invoke the function, never which rows a REAL
-- authenticated caller sees once inside.
-- ============================================================

-- ============================================================
-- 1. INDEXES — added only after EXPLAIN ANALYZE showed the existing
-- (ml_account_id, ...) indexes force a full index scan when searching
-- by these columns organization-wide (no ml_account_id in the
-- predicate): external_order_id search took ~695ms, pack_id ~305ms,
-- item_id ~166ms on the current 330k-row table. date_created listing
-- and seller_sku search already had adequate indexes
-- (orders_date_created_idx, order_items_sku_idx) and are untouched.
-- ============================================================

create index if not exists orders_org_external_idx
on public.orders (organization_id, external_order_id);

create index if not exists orders_org_pack_idx
on public.orders (organization_id, pack_id)
where pack_id is not null;

create index if not exists order_items_org_item_idx
on public.order_items (organization_id, item_id)
where is_current;

-- ============================================================
-- 2. SUMMARY — cards for the selected period/account.
-- ============================================================

create or replace function public.get_sales_orders_summary(
  target_organization_id uuid,
  date_from timestamptz,
  date_to timestamptz,
  target_ml_account_id uuid default null
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  caller_role text := coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '');
  result jsonb;
begin
  if not (private.is_organization_member(target_organization_id) or caller_role = 'service_role') then
    raise exception 'not_authorized';
  end if;

  with scoped_orders as materialized (
    select o.id, o.total_amount, o.paid_amount
    from public.orders as o
    where o.organization_id = target_organization_id
      and o.date_created >= date_from
      and o.date_created < date_to
      and (target_ml_account_id is null or o.ml_account_id = target_ml_account_id)
  ),
  item_totals as materialized (
    select oi.order_id, sum(oi.quantity) as units, sum(coalesce(oi.sale_fee, 0)) as fees
    from public.order_items as oi
    where oi.is_current
      and oi.order_id in (select id from scoped_orders)
    group by oi.order_id
  )
  select jsonb_build_object(
    'orders', count(*),
    'units', coalesce(sum(it.units), 0),
    'grossRevenue', coalesce(sum(so.total_amount), 0),
    'paidAmount', coalesce(sum(so.paid_amount), 0),
    'saleFees', coalesce(sum(it.fees), 0)
  )
  into result
  from scoped_orders as so
  left join item_totals as it on it.order_id = so.id;

  return result;
end;
$$;

revoke all on function public.get_sales_orders_summary(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.get_sales_orders_summary(uuid, timestamptz, timestamptz, uuid) to authenticated;

-- ============================================================
-- 3. PAGE — keyset pagination on (date_created, id), 1 row per order.
--
-- "Com atenção" (V1, deterministic, no invented logistics problem):
--   - some current item has no product_id (unmapped SKU), OR
--   - status is an unresolved/problematic real status
--     ('pending_cancel', 'partially_refunded' — the two non-terminal
--     statuses actually observed besides 'paid'/'cancelled'), OR
--   - ml_last_updated is recent (last 2 days) but the order has zero
--     current items at all (the sweep removed every line without a
--     replacement — a data anomaly worth surfacing, not a guess).
-- ============================================================

create or replace function public.get_sales_orders_page(
  target_organization_id uuid,
  date_from timestamptz,
  date_to timestamptz,
  target_ml_account_id uuid default null,
  status_filter text default 'all',
  search_query text default '',
  cursor_date timestamptz default null,
  cursor_id uuid default null,
  page_size integer default 50
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  caller_role text := coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '');
  safe_page_size integer := least(greatest(coalesce(page_size, 50), 1), 100);
  safe_status text := lower(btrim(coalesce(status_filter, 'all')));
  normalized_search text := lower(btrim(coalesce(search_query, '')));
  result jsonb;
begin
  if not (private.is_organization_member(target_organization_id) or caller_role = 'service_role') then
    raise exception 'not_authorized';
  end if;

  if safe_status not in ('all', 'paid', 'cancelled', 'attention') then
    raise exception 'invalid_sales_order_filter';
  end if;

  with scoped as materialized (
    select o.*
    from public.orders as o
    where o.organization_id = target_organization_id
      and o.date_created >= date_from
      and o.date_created < date_to
      and (target_ml_account_id is null or o.ml_account_id = target_ml_account_id)
  ),
  item_agg as materialized (
    select
      oi.order_id,
      sum(oi.quantity) as units,
      sum(coalesce(oi.sale_fee, 0)) as fees,
      count(*) as item_count,
      bool_or(oi.product_id is null) as has_unmapped_item,
      (array_agg(oi.title order by oi.created_at))[1] as first_title,
      (array_agg(oi.seller_sku order by oi.created_at))[1] as first_seller_sku
    from public.order_items as oi
    where oi.is_current
      and oi.order_id in (select id from scoped)
    group by oi.order_id
  ),
  flagged as materialized (
    select
      so.*,
      coalesce(ia.units, 0) as units,
      coalesce(ia.fees, 0) as sale_fees,
      coalesce(ia.item_count, 0) as item_count,
      ia.first_title,
      ia.first_seller_sku,
      (
        coalesce(ia.has_unmapped_item, false)
        or so.status in ('pending_cancel', 'partially_refunded')
        or (ia.order_id is null and so.ml_last_updated > now() - interval '2 days')
      ) as needs_attention
    from scoped as so
    left join item_agg as ia on ia.order_id = so.id
  ),
  matching as materialized (
    select f.*
    from flagged as f
    where (
      safe_status = 'all'
      or (safe_status = 'attention' and f.needs_attention)
      or (safe_status not in ('all', 'attention') and f.status = safe_status)
    )
    and (
      normalized_search = ''
      or f.external_order_id ilike ('%' || normalized_search || '%')
      or f.pack_id ilike ('%' || normalized_search || '%')
      or f.shipping_id ilike ('%' || normalized_search || '%')
      or exists (
        select 1 from public.order_items as oi
        where oi.order_id = f.id and oi.is_current
          and (
            oi.seller_sku ilike ('%' || normalized_search || '%')
            or oi.item_id ilike ('%' || normalized_search || '%')
            or oi.title ilike ('%' || normalized_search || '%')
          )
      )
      or exists (
        select 1 from public.order_items as oi
        join public.products as p on p.id = oi.product_id
        where oi.order_id = f.id and oi.is_current
          and p.sku_key ilike ('%' || normalized_search || '%')
      )
    )
  ),
  paged as materialized (
    select
      m.*,
      row_number() over (order by m.date_created desc, m.id desc) as rn
    from matching as m
    where cursor_date is null or (m.date_created, m.id) < (cursor_date, cursor_id)
    order by m.date_created desc, m.id desc
    limit safe_page_size + 1
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'orderId', p.id,
        'externalOrderId', p.external_order_id,
        'packId', p.pack_id,
        'accountId', p.ml_account_id,
        'accountCode', acc.code,
        'accountDisplayName', acc.display_name,
        'dateCreated', p.date_created,
        'status', p.status,
        'totalAmount', p.total_amount,
        'paidAmount', p.paid_amount,
        'shippingId', p.shipping_id,
        'units', p.units,
        'saleFees', p.sale_fees,
        'itemCount', p.item_count,
        'firstItemTitle', p.first_title,
        'firstItemSellerSku', p.first_seller_sku,
        'needsAttention', p.needs_attention
      ) order by p.date_created desc, p.id desc)
      from paged as p
      join public.ml_accounts as acc on acc.id = p.ml_account_id
      where p.rn <= safe_page_size
    ), '[]'::jsonb),
    'hasMore', exists(select 1 from paged where rn = safe_page_size + 1),
    'nextCursor', (
      select jsonb_build_object('dateCreated', p2.date_created, 'orderId', p2.id)
      from paged as p2
      where p2.rn = safe_page_size
    )
  )
  into result;

  return result;
end;
$$;

revoke all on function public.get_sales_orders_page(uuid, timestamptz, timestamptz, uuid, text, text, timestamptz, uuid, integer) from public, anon;
grant execute on function public.get_sales_orders_page(uuid, timestamptz, timestamptz, uuid, text, text, timestamptz, uuid, integer) to authenticated;

-- ============================================================
-- 4. DETAIL — single order + current items. Returns null (never an
-- error) for an id that doesn't exist OR belongs to an
-- organization/account the caller cannot see — RLS makes both cases
-- identical from the caller's point of view, which is exactly the
-- "never leaks which org an id belongs to" property we want.
-- ============================================================

create or replace function public.get_sales_order_detail(
  target_organization_id uuid,
  target_order_id uuid
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  caller_role text := coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '');
  header jsonb;
  items jsonb;
begin
  if not (private.is_organization_member(target_organization_id) or caller_role = 'service_role') then
    raise exception 'not_authorized';
  end if;

  select jsonb_build_object(
    'orderId', o.id,
    'externalOrderId', o.external_order_id,
    'packId', o.pack_id,
    'shippingId', o.shipping_id,
    'status', o.status,
    'accountId', o.ml_account_id,
    'accountCode', acc.code,
    'accountDisplayName', acc.display_name,
    'totalAmount', o.total_amount,
    'paidAmount', o.paid_amount,
    'currencyId', o.currency_id,
    'tags', o.tags,
    'dateCreated', o.date_created,
    'dateClosed', o.date_closed,
    'mlLastUpdated', o.ml_last_updated
  )
  into header
  from public.orders as o
  join public.ml_accounts as acc on acc.id = o.ml_account_id
  where o.id = target_order_id
    and o.organization_id = target_organization_id;

  if header is null then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'orderItemId', oi.id,
    'productId', oi.product_id,
    'sellerSku', oi.seller_sku,
    'itemId', oi.item_id,
    'variationId', oi.variation_id,
    'title', oi.title,
    'quantity', oi.quantity,
    'unitPrice', oi.unit_price,
    'fullUnitPrice', oi.full_unit_price,
    'saleFee', oi.sale_fee,
    'permalink', listing.permalink
  ) order by oi.created_at), '[]'::jsonb)
  into items
  from public.order_items as oi
  left join public.ml_listings as listing on listing.id = oi.ml_listing_id
  where oi.order_id = target_order_id
    and oi.is_current;

  return header || jsonb_build_object('items', items);
end;
$$;

revoke all on function public.get_sales_order_detail(uuid, uuid) from public, anon;
grant execute on function public.get_sales_order_detail(uuid, uuid) to authenticated;

-- ============================================================
-- 5. PRODUCT SALES TIMELINE — reusable read model, prep work for
-- ETAPA 35's diagnostic AI (no analysis/text generation here). Sources
-- exclusively from daily_product_metrics (already rebuilt by
-- rebuild_sales_metrics_for_account_range on every order refresh) —
-- never re-scans raw orders. When target_ml_account_id is omitted,
-- sums across every account the caller can see for that product/day.
-- ============================================================

create or replace function public.get_product_sales_timeline_events(
  target_organization_id uuid,
  target_product_id uuid,
  date_from date,
  date_to date,
  target_ml_account_id uuid default null
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  caller_role text := coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '');
  result jsonb;
begin
  if not (private.is_organization_member(target_organization_id) or caller_role = 'service_role') then
    raise exception 'not_authorized';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'metricDate', t.metric_date,
    'unitsSold', t.units_sold,
    'ordersCount', t.orders_count,
    'grossRevenue', t.gross_revenue,
    'saleFees', t.sale_fees,
    'netAfterSaleFee', t.net_after_sale_fee
  ) order by t.metric_date), '[]'::jsonb)
  into result
  from (
    select
      m.metric_date,
      sum(m.units_sold) as units_sold,
      sum(m.orders_count) as orders_count,
      sum(m.gross_revenue) as gross_revenue,
      sum(m.sale_fees) as sale_fees,
      sum(m.net_after_sale_fee) as net_after_sale_fee
    from public.daily_product_metrics as m
    where m.organization_id = target_organization_id
      and m.product_id = target_product_id
      and m.metric_date between date_from and date_to
      and (target_ml_account_id is null or m.ml_account_id = target_ml_account_id)
    group by m.metric_date
  ) as t;

  return result;
end;
$$;

revoke all on function public.get_product_sales_timeline_events(uuid, uuid, date, date, uuid) from public, anon;
grant execute on function public.get_product_sales_timeline_events(uuid, uuid, date, date, uuid) to authenticated;
