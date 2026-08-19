-- ETAPA 35: Diagnostico inteligente com Claude.
--
-- product_diagnostic_runs persists every diagnostic attempt (succeeded or
-- failed), keyed for a cache lookup by (organization_id, product_id,
-- evidence_hash, prompt_version, model, status='succeeded') and used as an
-- atomic lock: a 'running' row is inserted before calling Anthropic, guarded
-- by a partial unique index so a concurrent second click gets a unique-
-- violation instead of triggering a second API call. This avoids session-
-- level advisory locks, which are unreliable across pooled connections.
create table public.product_diagnostic_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  requested_by uuid not null references auth.users(id),
  status text not null check (status in ('running', 'succeeded', 'failed')),
  diagnostic_trigger text not null default 'manual',
  evidence_version text not null,
  evidence_hash text not null,
  prompt_version text not null,
  model text not null,
  evidence jsonb not null,
  result jsonb,
  anthropic_message_id text,
  input_tokens integer,
  output_tokens integer,
  cache_creation_input_tokens integer,
  cache_read_input_tokens integer,
  latency_ms integer,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index product_diagnostic_runs_running_lock_idx
  on public.product_diagnostic_runs (organization_id, product_id)
  where status = 'running';

create index product_diagnostic_runs_cache_idx
  on public.product_diagnostic_runs (organization_id, product_id, evidence_hash, prompt_version, model, status);

create index product_diagnostic_runs_latest_idx
  on public.product_diagnostic_runs (organization_id, product_id, created_at desc);

alter table public.product_diagnostic_runs enable row level security;

create policy product_diagnostic_runs_select_members
  on public.product_diagnostic_runs
  for select
  to authenticated
  using (private.is_organization_member(organization_id));

-- Widen the existing per-SKU planning signal (introduced in
-- 20260819110000_fix_diagnostic_rpc_and_add_supplier_document_check.sql) with
-- the fields the diagnostic evidence engine needs for "Parte G — Compra":
-- suggested purchase quantity, planning status, coverage, lead time and
-- sales velocity. Same jsonb return shape, so create-or-replace is safe
-- (no column-set change like a `returns table` function would hit).
create or replace function public.get_purchase_planning_signal_for_sku(target_organization_id uuid, target_source_sku_key text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  caller_role text := coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '');
  result jsonb;
begin
  if caller_role <> 'service_role' then
    raise exception 'not_authorized';
  end if;

  select jsonb_build_object(
    'sourceSkuKey', signal.source_sku_key,
    'purchaseInTransit', signal.purchase_in_transit,
    'upsellerPurchaseInTransit', signal.upseller_purchase_in_transit,
    'internalPurchaseInTransit', signal.internal_purchase_in_transit,
    'effectivePurchaseInTransit', signal.purchase_in_transit,
    'suggestedPurchaseQuantity', signal.suggested_purchase_quantity,
    'purchasePlanningStatus', signal.status,
    'coverageDays', signal.coverage_days,
    'leadTimeDays', signal.lead_time_days,
    'avgDailySales30', signal.avg_daily_sales_30,
    'salesVelocityReady', signal.sales_velocity_ready
  )
  into result
  from private.get_purchase_planning_signals(target_organization_id) as signal
  where signal.source_sku_key = target_source_sku_key;

  return result;
end;
$function$;

-- Compact evidence RPC for a single product's diagnostic. Returns raw
-- aggregated facts only (sums, transition lists) — deltas, triggers and the
-- final evidence-id objects are computed deterministically in TypeScript
-- (src/features/product-diagnostics/product-diagnostic-domain.ts) so they
-- stay unit-testable without a database. Deliberately does NOT recompute
-- physical stock, Full current state, mapping or advertised-offer counts —
-- those are already owned by getProductStockIntelligence() and are merged
-- in by the TS evidence builder to avoid a second interpretation.
create or replace function public.get_product_diagnostic_evidence(
  target_organization_id uuid,
  target_product_id uuid,
  as_of_date date
)
returns jsonb
language plpgsql
stable security definer
set search_path to ''
as $function$
declare
  caller_role text := coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '');
  v_source_sku_key text;
  v_mapping_status text;
  v_last90_from date := as_of_date - 89;
  result jsonb;
begin
  if not (private.is_organization_member(target_organization_id) or caller_role = 'service_role') then
    raise exception 'not_authorized';
  end if;

  select link.source_sku_key into v_source_sku_key
  from public.product_inventory_links as link
  where link.organization_id = target_organization_id
    and link.product_id = target_product_id
    and link.source = 'upseller'
    and link.is_active = true;

  v_mapping_status := case
    when exists (
      select 1 from public.product_inventory_link_conflicts as conflict
      where conflict.organization_id = target_organization_id
        and conflict.product_id = target_product_id
        and conflict.source = 'upseller'
        and conflict.is_current
    ) then 'conflict'
    when v_source_sku_key is not null then 'linked'
    else 'missing'
  end;

  with daily as (
    select m.metric_date, m.ml_account_id, m.units_sold, m.orders_count, m.gross_revenue
    from public.daily_product_metrics as m
    where m.organization_id = target_organization_id
      and m.product_id = target_product_id
      and m.metric_date between v_last90_from and as_of_date
  ),
  sales_total as (
    select
      coalesce(sum(units_sold) filter (where metric_date between as_of_date - 6 and as_of_date), 0)::numeric as units7,
      coalesce(sum(units_sold) filter (where metric_date between as_of_date - 13 and as_of_date - 7), 0)::numeric as previous_units7,
      coalesce(sum(gross_revenue) filter (where metric_date between as_of_date - 6 and as_of_date), 0)::numeric as revenue7,
      coalesce(sum(gross_revenue) filter (where metric_date between as_of_date - 13 and as_of_date - 7), 0)::numeric as previous_revenue7,
      coalesce(sum(orders_count) filter (where metric_date between as_of_date - 6 and as_of_date), 0)::numeric as orders7,
      coalesce(sum(orders_count) filter (where metric_date between as_of_date - 13 and as_of_date - 7), 0)::numeric as previous_orders7,
      coalesce(sum(units_sold) filter (where metric_date between as_of_date - 29 and as_of_date), 0)::numeric as units30,
      coalesce(sum(units_sold) filter (where metric_date between as_of_date - 59 and as_of_date - 30), 0)::numeric as previous_units30,
      coalesce(sum(gross_revenue) filter (where metric_date between as_of_date - 29 and as_of_date), 0)::numeric as revenue30,
      coalesce(sum(gross_revenue) filter (where metric_date between as_of_date - 59 and as_of_date - 30), 0)::numeric as previous_revenue30,
      coalesce(sum(orders_count) filter (where metric_date between as_of_date - 29 and as_of_date), 0)::numeric as orders30,
      coalesce(sum(orders_count) filter (where metric_date between as_of_date - 59 and as_of_date - 30), 0)::numeric as previous_orders30,
      coalesce(sum(units_sold) filter (where metric_date between as_of_date - 89 and as_of_date), 0)::numeric as units90,
      count(distinct metric_date) filter (where metric_date between as_of_date - 6 and as_of_date and units_sold > 0) as days_with_sales7,
      count(distinct metric_date) filter (where metric_date between as_of_date - 29 and as_of_date and units_sold > 0) as days_with_sales30,
      max(metric_date) filter (where units_sold > 0) as last_sale_date
    from daily
  ),
  sales_by_account as (
    select
      m.ml_account_id,
      account.code as account_code,
      account.display_name as account_display_name,
      coalesce(sum(m.units_sold) filter (where m.metric_date between as_of_date - 6 and as_of_date), 0)::numeric as units7,
      coalesce(sum(m.units_sold) filter (where m.metric_date between as_of_date - 13 and as_of_date - 7), 0)::numeric as previous_units7,
      coalesce(sum(m.units_sold) filter (where m.metric_date between as_of_date - 29 and as_of_date), 0)::numeric as units30,
      coalesce(sum(m.units_sold) filter (where m.metric_date between as_of_date - 59 and as_of_date - 30), 0)::numeric as previous_units30,
      coalesce(sum(m.gross_revenue) filter (where m.metric_date between as_of_date - 29 and as_of_date), 0)::numeric as revenue30,
      coalesce(sum(m.orders_count) filter (where m.metric_date between as_of_date - 29 and as_of_date), 0)::numeric as orders30
    from daily as m
    join public.ml_accounts as account on account.id = m.ml_account_id
    group by m.ml_account_id, account.code, account.display_name
  ),
  coverage_runs as (
    select run.ml_account_id, run.metadata
    from public.sync_runs as run
    join public.ml_accounts as account on account.id = run.ml_account_id
    where account.organization_id = target_organization_id
      and run.sync_type = 'orders_dashboard_backfill'
      and run.status = 'succeeded'
  ),
  active_accounts as (
    select id from public.ml_accounts
    where organization_id = target_organization_id and is_active
  ),
  sales_coverage as (
    select
      (select count(*) from active_accounts) > 0
      and (select count(*) from active_accounts) = (
        select count(distinct account.id)
        from active_accounts as account
        where exists (
          select 1 from coverage_runs as run
          where run.ml_account_id = account.id
            and (run.metadata ->> 'covered_from') <= v_last90_from::text
        )
      ) as ready
  ),
  product_listings as (
    select l.id as ml_listing_id, l.ml_account_id, l.item_id, l.inventory_id
    from public.ml_listings as l
    where l.organization_id = target_organization_id
      and l.product_id = target_product_id
      and l.is_current = true
  ),
  price_snapshots as (
    select
      s.ml_listing_id,
      s.ml_account_id,
      s.item_id,
      s.captured_at,
      s.effective_price,
      s.base_price,
      s.has_active_promotion,
      s.promotion_id,
      s.promotion_status,
      s.promotion_name,
      s.promotion_started_at,
      s.promotion_ends_at,
      lag(s.effective_price) over w as prev_effective_price,
      lag(s.has_active_promotion) over w as prev_has_active_promotion,
      lag(s.promotion_id) over w as prev_promotion_id
    from public.ml_offer_price_state_snapshots as s
    where s.organization_id = target_organization_id
      and s.product_id = target_product_id
      and s.captured_at >= (as_of_date - 89)::timestamptz
    window w as (partition by s.ml_listing_id order by s.captured_at)
  ),
  price_events as (
    select jsonb_build_object(
      'type', 'PRICE_EFFECTIVE_CHANGED',
      'occurredAt', captured_at,
      'mlAccountId', ml_account_id,
      'itemId', item_id,
      'before', prev_effective_price,
      'after', effective_price,
      'percentageChange', case when prev_effective_price > 0 then round(((effective_price - prev_effective_price) / prev_effective_price) * 100, 2) end
    ) as event
    from price_snapshots
    where prev_effective_price is not null
      and effective_price is not null
      and effective_price is distinct from prev_effective_price
  ),
  promotion_events as (
    select jsonb_build_object(
      'type', case
        when prev_has_active_promotion = false and has_active_promotion = true then 'PROMOTION_STARTED'
        when prev_has_active_promotion = true and has_active_promotion = false then 'PROMOTION_ENDED'
        else 'PROMOTION_CHANGED'
      end,
      'occurredAt', captured_at,
      'mlAccountId', ml_account_id,
      'itemId', item_id,
      'promotionId', promotion_id,
      'promotionName', promotion_name,
      'promotionStatus', promotion_status,
      'promotionStartedAt', promotion_started_at,
      'promotionEndsAt', promotion_ends_at
    ) as event
    from price_snapshots
    where prev_has_active_promotion is not null
      and (
        prev_has_active_promotion is distinct from has_active_promotion
        or (has_active_promotion and promotion_id is distinct from prev_promotion_id)
      )
  ),
  price_current as (
    select
      st.ml_account_id, st.item_id, st.effective_price, st.base_price,
      st.has_active_promotion, st.promotion_status, st.promotion_name,
      st.promotion_started_at, st.promotion_ends_at, st.captured_at
    from public.ml_offer_price_states as st
    where st.organization_id = target_organization_id
      and st.product_id = target_product_id
  ),
  full_targets as (
    select distinct pl.ml_account_id, pl.inventory_id
    from product_listings as pl
    where pl.inventory_id is not null
    union
    select distinct v.ml_account_id, v.inventory_id
    from public.ml_listing_variations as v
    where v.organization_id = target_organization_id
      and v.product_id = target_product_id
      and v.is_current = true
      and v.inventory_id is not null
  ),
  full_snapshots as (
    select
      fs.ml_account_id, fs.inventory_id, fs.captured_at,
      fs.available_quantity, fs.total_quantity,
      lag(fs.available_quantity) over w as prev_available_quantity
    from public.ml_fulfillment_stock_snapshots as fs
    join full_targets as t on t.ml_account_id = fs.ml_account_id and t.inventory_id = fs.inventory_id
    where fs.organization_id = target_organization_id
      and fs.captured_at >= (as_of_date - 89)::timestamptz
    window w as (partition by fs.ml_account_id, fs.inventory_id order by fs.captured_at)
  ),
  full_events as (
    select jsonb_build_object(
      'type', case
        when prev_available_quantity > 0 and available_quantity = 0 then 'FULL_ZERO'
        when prev_available_quantity = 0 and available_quantity > 0 then 'FULL_RESTORED'
        else 'FULL_DROP'
      end,
      'occurredAt', captured_at,
      'mlAccountId', ml_account_id,
      'inventoryId', inventory_id,
      'before', prev_available_quantity,
      'after', available_quantity
    ) as event
    from full_snapshots
    where prev_available_quantity is not null
      and available_quantity is distinct from prev_available_quantity
      and (
        (prev_available_quantity > 0 and available_quantity = 0)
        or (prev_available_quantity = 0 and available_quantity > 0)
        or (prev_available_quantity > 0 and available_quantity > 0 and available_quantity <= prev_available_quantity * 0.5)
      )
  ),
  alerts as (
    select jsonb_build_object(
      'alertType', a.alert_type,
      'severity', a.severity,
      'evidence', a.evidence,
      'suggestedActionCode', a.suggested_action_code,
      'firstSeenAt', a.first_seen_at,
      'lastSeenAt', a.last_seen_at
    ) as alert
    from public.operational_alerts as a
    where a.organization_id = target_organization_id
      and a.product_id = target_product_id
      and a.status = 'open'
  ),
  open_purchase_orders as (
    select jsonb_build_object(
      'purchaseOrderId', po.id,
      'orderNumber', 'PC-' || lpad(po.order_number::text, 6, '0'),
      'status', po.status,
      'expectedAt', po.expected_at,
      'quantityOrdered', item.quantity_ordered,
      'outstandingQuantity', item.quantity_ordered - item.cancelled_quantity
    ) as po
    from public.purchase_order_items as item
    join public.purchase_orders as po on po.id = item.purchase_order_id
    where po.organization_id = target_organization_id
      and po.status in ('draft', 'approved', 'ordered', 'partially_received')
      and v_source_sku_key is not null
      and item.source_sku_key = v_source_sku_key
  )
  select jsonb_build_object(
    'asOfDate', as_of_date,
    'sourceSkuKey', v_source_sku_key,
    'mappingStatus', v_mapping_status,
    'sales', (
      select to_jsonb(sales_total) from sales_total
    ),
    'salesByAccount', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'mlAccountId', ml_account_id, 'accountCode', account_code, 'accountDisplayName', account_display_name,
        'units7', units7, 'previousUnits7', previous_units7, 'units30', units30, 'previousUnits30', previous_units30,
        'revenue30', revenue30, 'orders30', orders30
      )), '[]'::jsonb) from sales_by_account
    ),
    'salesCoverageReady', (select ready from sales_coverage),
    'salesCoverageFrom', v_last90_from,
    'salesCoverageTo', as_of_date,
    'priceEvents', (select coalesce(jsonb_agg(event order by (event ->> 'occurredAt')), '[]'::jsonb) from price_events),
    'promotionEvents', (select coalesce(jsonb_agg(event order by (event ->> 'occurredAt')), '[]'::jsonb) from promotion_events),
    'priceCurrent', (select coalesce(jsonb_agg(to_jsonb(price_current)), '[]'::jsonb) from price_current),
    'priceHistoryFrom', (select min(captured_at) from price_snapshots),
    'priceHistoryTo', (select max(captured_at) from price_snapshots),
    'priceCheckedAt', (select max(captured_at) from price_current),
    'fullEvents', (select coalesce(jsonb_agg(event order by (event ->> 'occurredAt')), '[]'::jsonb) from full_events),
    'fullHistoryFrom', (select min(captured_at) from full_snapshots),
    'fullHistoryTo', (select max(captured_at) from full_snapshots),
    'alerts', (select coalesce(jsonb_agg(alert), '[]'::jsonb) from alerts),
    'openPurchaseOrders', (select coalesce(jsonb_agg(po), '[]'::jsonb) from open_purchase_orders)
  )
  into result;

  return result;
end;
$function$;

grant execute on function public.get_product_diagnostic_evidence(uuid, uuid, date) to authenticated, service_role;
grant execute on function public.get_purchase_planning_signal_for_sku(uuid, text) to service_role;
