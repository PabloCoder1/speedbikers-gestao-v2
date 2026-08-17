-- Compact, RLS-aware read models for /estoque and /alertas.

create index if not exists operational_alerts_overview_idx
  on public.operational_alerts (organization_id, status, severity, last_seen_at desc);

create index if not exists daily_product_metrics_velocity_idx
  on public.daily_product_metrics (organization_id, product_id, metric_date, ml_account_id);

create or replace function public.get_stock_overview_data(target_organization_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not private.is_organization_member(target_organization_id) then
    raise exception 'not_authorized';
  end if;

  return jsonb_build_object(
    'stockReceiptReady', true,
    'products', coalesce((
      select jsonb_agg(to_jsonb(dataset)) from (
        select product.id, product.sku, product.name
        from public.products product
        where product.organization_id = target_organization_id
        order by product.sku, product.id
      ) dataset
    ), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(to_jsonb(dataset)) from (
        select link.product_id, link.source_sku, link.source_sku_key, link.source_kind
        from public.product_inventory_links link
        where link.organization_id = target_organization_id
          and link.source = 'upseller' and link.is_active
        order by link.product_id
      ) dataset
    ), '[]'::jsonb),
    'conflicts', coalesce((
      select jsonb_agg(to_jsonb(dataset)) from (
        select conflict.product_id
        from public.product_inventory_link_conflicts conflict
        where conflict.organization_id = target_organization_id
          and conflict.source = 'upseller' and conflict.is_current
        order by conflict.product_id
      ) dataset
    ), '[]'::jsonb),
    'stockStates', coalesce((
      select jsonb_agg(to_jsonb(dataset)) from (
        select state.sku_key, state.warehouse_name, state.warehouse_key,
          state.available_quantity, state.current_quantity, state.low_stock_threshold,
          state.source_import_id, state.checked_at
        from public.upseller_stock_states state
        where state.organization_id = target_organization_id
        order by state.sku_key, state.warehouse_key
      ) dataset
    ), '[]'::jsonb),
    'kits', coalesce((
      select jsonb_agg(to_jsonb(dataset)) from (
        select kit.kit_sku_key
        from public.upseller_kits kit
        where kit.organization_id = target_organization_id and kit.is_current
        order by kit.kit_sku_key
      ) dataset
    ), '[]'::jsonb),
    'kitComponents', coalesce((
      select jsonb_agg(to_jsonb(dataset)) from (
        select component.kit_sku_key, component.component_sku_key, component.required_quantity
        from public.upseller_kit_components component
        where component.organization_id = target_organization_id and component.is_current
        order by component.kit_sku_key, component.component_sku_key
      ) dataset
    ), '[]'::jsonb),
    'listings', coalesce((
      select jsonb_agg(to_jsonb(dataset)) from (
        select listing.id, listing.product_id, listing.ml_account_id, listing.status,
          listing.available_quantity, listing.inventory_id, listing.ml_last_updated
        from public.ml_listings listing
        where listing.organization_id = target_organization_id and listing.is_current
        order by listing.id
      ) dataset
    ), '[]'::jsonb),
    'variations', coalesce((
      select jsonb_agg(to_jsonb(dataset)) from (
        select variation.id, variation.product_id, variation.ml_account_id,
          variation.ml_listing_id, variation.available_quantity, variation.inventory_id,
          variation.last_seen_at
        from public.ml_listing_variations variation
        where variation.organization_id = target_organization_id and variation.is_current
        order by variation.id
      ) dataset
    ), '[]'::jsonb),
    'fulfillmentStates', coalesce((
      select jsonb_agg(to_jsonb(dataset)) from (
        select state.ml_account_id, state.inventory_id, state.available_quantity,
          state.total_quantity, state.not_available_quantity, state.checked_at
        from public.ml_fulfillment_stock_states state
        where state.organization_id = target_organization_id
        order by state.ml_account_id, state.inventory_id
      ) dataset
    ), '[]'::jsonb),
    'mlAccounts', coalesce((
      select jsonb_agg(to_jsonb(dataset)) from (
        select account.id, account.code, account.display_name
        from public.ml_accounts account
        where account.organization_id = target_organization_id
        order by account.display_name, account.id
      ) dataset
    ), '[]'::jsonb),
    'receiptAdjustments', coalesce((
      select jsonb_agg(to_jsonb(dataset)) from (
        select adjustment.sku_key, adjustment.warehouse_key,
          adjustment.quantity, adjustment.applied_at
        from public.current_stock_receipt_adjustments adjustment
        where adjustment.organization_id = target_organization_id
        order by adjustment.sku_key, adjustment.warehouse_key, adjustment.applied_at
      ) dataset
    ), '[]'::jsonb),
    'alerts', coalesce((
      select jsonb_agg(to_jsonb(dataset)) from (
        select alert.product_id, alert.severity
        from public.operational_alerts alert
        where alert.organization_id = target_organization_id and alert.status = 'open'
        order by alert.product_id, alert.severity
      ) dataset
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.get_operational_alerts_data(
  target_organization_id uuid,
  requested_scope text default 'open'
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not private.is_organization_member(target_organization_id) then
    raise exception 'not_authorized';
  end if;
  if requested_scope not in ('open','resolved','all') then
    raise exception 'invalid_alert_scope';
  end if;

  return jsonb_build_object(
    'summary', (
      select jsonb_build_object(
        'open', count(*) filter (where alert.status = 'open'),
        'critical', count(*) filter (where alert.status = 'open' and alert.severity = 'critical'),
        'warning', count(*) filter (where alert.status = 'open' and alert.severity = 'warning'),
        'info', count(*) filter (where alert.status = 'open' and alert.severity = 'info'),
        'resolved', count(*) filter (where alert.status = 'resolved')
      )
      from public.operational_alerts alert
      where alert.organization_id = target_organization_id
    ),
    'alerts', coalesce((
      select jsonb_agg(to_jsonb(dataset)) from (
        select alert.id, alert.product_id, alert.alert_type, alert.severity,
          alert.status, alert.evidence, alert.suggested_action_code,
          alert.last_seen_at, alert.resolved_at, product.sku, product.name as product_name
        from public.operational_alerts alert
        join public.products product
          on product.organization_id = alert.organization_id and product.id = alert.product_id
        where alert.organization_id = target_organization_id
          and (requested_scope = 'all' or alert.status = requested_scope)
        order by alert.last_seen_at desc, alert.id
      ) dataset
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_stock_overview_data(uuid) from public, anon;
revoke all on function public.get_operational_alerts_data(uuid, text) from public, anon;
grant execute on function public.get_stock_overview_data(uuid) to authenticated;
grant execute on function public.get_operational_alerts_data(uuid, text) to authenticated;

