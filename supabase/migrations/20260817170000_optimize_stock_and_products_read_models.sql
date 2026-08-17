-- Bounded, set-based read models for /estoque and /produtos.
-- The helper returns compact per-product signals and never exposes raw payloads.

create or replace function private.get_stock_product_signals(
  target_organization_id uuid,
  search_query text default ''
)
returns table (
  product_id uuid,
  sku text,
  sku_key text,
  product_name text,
  mapping_status text,
  source_sku text,
  source_sku_key text,
  source_kind text,
  physical_ready boolean,
  physical_available numeric,
  physical_current numeric,
  low_stock_threshold numeric,
  advertised_offers bigint,
  active_offers bigint,
  advertised_available bigint,
  full_applicable boolean,
  full_ready boolean,
  full_pending bigint,
  full_has_zero boolean,
  full_available bigint,
  open_alerts bigint,
  alert_severity text,
  operational_status text,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_search text := lower(btrim(coalesce(search_query, '')));
begin
  if not private.is_organization_member(target_organization_id) then
    raise exception 'not_authorized';
  end if;

  return query
  with accessible_accounts as materialized (
    select account.id, account.code, account.display_name
    from public.ml_accounts as account
    where account.organization_id = target_organization_id
      and private.can_access_ml_account(account.id)
  ),
  candidate_products as materialized (
    select product.id, product.sku, product.sku_key, product.name
    from public.products as product
    where product.organization_id = target_organization_id
      and (
        normalized_search = ''
        or position(normalized_search in lower(product.sku)) > 0
        or position(normalized_search in lower(coalesce(product.name, ''))) > 0
        or exists (
          select 1
          from public.product_inventory_links as searched_link
          where searched_link.organization_id = target_organization_id
            and searched_link.product_id = product.id
            and searched_link.source = 'upseller'
            and searched_link.is_active
            and position(normalized_search in lower(searched_link.source_sku)) > 0
        )
      )
  ),
  links as materialized (
    select link.product_id, link.source_sku, link.source_sku_key, link.source_kind
    from public.product_inventory_links as link
    join candidate_products as product on product.id = link.product_id
    where link.organization_id = target_organization_id
      and link.source = 'upseller'
      and link.is_active
  ),
  conflicts as materialized (
    select conflict.product_id
    from public.product_inventory_link_conflicts as conflict
    join candidate_products as product on product.id = conflict.product_id
    where conflict.organization_id = target_organization_id
      and conflict.source = 'upseller'
      and conflict.is_current
  ),
  receipt_adjustments as materialized (
    select
      adjustment.sku_key,
      adjustment.warehouse_key,
      sum(adjustment.quantity) as quantity,
      max(adjustment.applied_at) as applied_at
    from public.current_stock_receipt_adjustments as adjustment
    where adjustment.organization_id = target_organization_id
    group by adjustment.sku_key, adjustment.warehouse_key
  ),
  stock_by_warehouse as materialized (
    select
      state.sku_key,
      state.warehouse_key,
      state.available_quantity + coalesce(adjustment.quantity, 0) as available_quantity,
      state.current_quantity + coalesce(adjustment.quantity, 0) as current_quantity,
      state.low_stock_threshold,
      greatest(state.checked_at, adjustment.applied_at) as updated_at
    from public.upseller_stock_states as state
    left join receipt_adjustments as adjustment
      on adjustment.sku_key = state.sku_key
     and adjustment.warehouse_key = state.warehouse_key
    where state.organization_id = target_organization_id
  ),
  simple_stock as materialized (
    select
      stock.sku_key,
      sum(stock.available_quantity) as available_quantity,
      sum(stock.current_quantity) as current_quantity,
      sum(stock.low_stock_threshold) as low_stock_threshold,
      max(stock.updated_at) as updated_at
    from stock_by_warehouse as stock
    group by stock.sku_key
  ),
  relevant_kits as materialized (
    select distinct link.source_sku_key as kit_sku_key
    from links as link
    where link.source_kind = 'kit'
  ),
  kit_component_metadata as materialized (
    select
      component.kit_sku_key,
      count(*)::bigint as component_count,
      count(*) filter (where component_stock.sku_key is not null)::bigint as components_with_stock,
      bool_or(nested_kit.kit_sku_key is not null) as has_nested_kit,
      max(component_stock.updated_at) as updated_at
    from public.upseller_kit_components as component
    join relevant_kits as relevant on relevant.kit_sku_key = component.kit_sku_key
    left join simple_stock as component_stock
      on component_stock.sku_key = component.component_sku_key
    left join public.upseller_kits as nested_kit
      on nested_kit.organization_id = target_organization_id
     and nested_kit.kit_sku_key = component.component_sku_key
     and nested_kit.is_current
    where component.organization_id = target_organization_id
      and component.is_current
    group by component.kit_sku_key
  ),
  kit_warehouse_capacity as materialized (
    select
      component.kit_sku_key,
      stock.warehouse_key,
      min(floor(stock.available_quantity / component.required_quantity)) as available_quantity
    from public.upseller_kit_components as component
    join relevant_kits as relevant on relevant.kit_sku_key = component.kit_sku_key
    join stock_by_warehouse as stock on stock.sku_key = component.component_sku_key
    where component.organization_id = target_organization_id
      and component.is_current
    group by component.kit_sku_key, stock.warehouse_key
    having count(*) = (
      select count(*)
      from public.upseller_kit_components as expected_component
      where expected_component.organization_id = target_organization_id
        and expected_component.kit_sku_key = component.kit_sku_key
        and expected_component.is_current
    )
  ),
  kit_stock as materialized (
    select
      metadata.kit_sku_key,
      (
        metadata.component_count > 0
        and metadata.components_with_stock = metadata.component_count
        and not metadata.has_nested_kit
        and count(capacity.warehouse_key) > 0
      ) as ready,
      case
        when metadata.component_count > 0
          and metadata.components_with_stock = metadata.component_count
          and not metadata.has_nested_kit
          and count(capacity.warehouse_key) > 0
        then coalesce(sum(capacity.available_quantity), 0)
        else null
      end as available_quantity,
      metadata.updated_at
    from kit_component_metadata as metadata
    left join kit_warehouse_capacity as capacity
      on capacity.kit_sku_key = metadata.kit_sku_key
    group by
      metadata.kit_sku_key,
      metadata.component_count,
      metadata.components_with_stock,
      metadata.has_nested_kit,
      metadata.updated_at
  ),
  offers as materialized (
    select
      'listing:' || listing.id::text as offer_key,
      listing.product_id,
      listing.ml_account_id,
      listing.status,
      listing.available_quantity,
      listing.inventory_id,
      listing.ml_last_updated as updated_at
    from public.ml_listings as listing
    join accessible_accounts as account on account.id = listing.ml_account_id
    join candidate_products as product on product.id = listing.product_id
    where listing.organization_id = target_organization_id
      and listing.is_current
      and listing.product_id is not null

    union all

    select
      'variation:' || variation.id::text,
      variation.product_id,
      variation.ml_account_id,
      listing.status,
      coalesce(variation.available_quantity, listing.available_quantity),
      variation.inventory_id,
      greatest(variation.last_seen_at, listing.ml_last_updated)
    from public.ml_listing_variations as variation
    join accessible_accounts as account on account.id = variation.ml_account_id
    join candidate_products as product on product.id = variation.product_id
    join public.ml_listings as listing
      on listing.organization_id = variation.organization_id
     and listing.ml_account_id = variation.ml_account_id
     and listing.id = variation.ml_listing_id
    where variation.organization_id = target_organization_id
      and variation.is_current
      and variation.product_id is not null
  ),
  offer_totals as materialized (
    select
      offer.product_id,
      count(*) as advertised_offers,
      count(*) filter (where offer.status = 'active') as active_offers,
      sum(coalesce(offer.available_quantity, 0))::bigint as advertised_available,
      max(offer.updated_at) as updated_at
    from offers as offer
    group by offer.product_id
  ),
  inventory_targets as materialized (
    select distinct offer.product_id, offer.ml_account_id, offer.inventory_id
    from offers as offer
    where offer.inventory_id is not null
  ),
  full_by_account as materialized (
    select
      target.product_id,
      target.ml_account_id,
      count(*)::bigint as inventory_count,
      count(state.inventory_id)::bigint as checked_inventory_count,
      sum(state.available_quantity)::bigint as available_quantity,
      max(state.checked_at) as updated_at
    from inventory_targets as target
    left join public.ml_fulfillment_stock_states as state
      on state.organization_id = target_organization_id
     and state.ml_account_id = target.ml_account_id
     and state.inventory_id = target.inventory_id
    group by target.product_id, target.ml_account_id
  ),
  full_totals as materialized (
    select
      full_account.product_id,
      sum(full_account.inventory_count)::bigint as inventory_count,
      sum(full_account.checked_inventory_count)::bigint as checked_inventory_count,
      sum(full_account.available_quantity)::bigint as available_quantity,
      bool_or(
        full_account.checked_inventory_count = full_account.inventory_count
        and coalesce(full_account.available_quantity, 0) = 0
      ) as has_zero,
      max(full_account.updated_at) as updated_at
    from full_by_account as full_account
    group by full_account.product_id
  ),
  alert_totals as materialized (
    select
      alert.product_id,
      count(*)::bigint as open_alerts,
      case min(
        case alert.severity
          when 'critical' then 1
          when 'warning' then 2
          else 3
        end
      )
        when 1 then 'critical'
        when 2 then 'warning'
        else 'info'
      end as alert_severity,
      max(alert.last_seen_at) as updated_at
    from public.operational_alerts as alert
    join candidate_products as product on product.id = alert.product_id
    where alert.organization_id = target_organization_id
      and alert.status = 'open'
    group by alert.product_id
  ),
  signals as (
    select
      product.id as product_id,
      product.sku,
      product.sku_key,
      product.name as product_name,
      case
        when conflict.product_id is not null then 'conflict'
        when link.product_id is not null then 'linked'
        else 'missing'
      end as mapping_status,
      case when conflict.product_id is null then link.source_sku end as source_sku,
      case when conflict.product_id is null then link.source_sku_key end as source_sku_key,
      case when conflict.product_id is null then link.source_kind end as source_kind,
      case
        when conflict.product_id is not null or link.product_id is null then false
        when link.source_kind = 'simple' then simple.sku_key is not null
        when link.source_kind = 'kit' then coalesce(kit.ready, false)
        else false
      end as physical_ready,
      case
        when conflict.product_id is not null or link.product_id is null then null
        when link.source_kind = 'simple' then simple.available_quantity
        when link.source_kind = 'kit' and kit.ready then kit.available_quantity
        else null
      end as physical_available,
      case
        when conflict.product_id is null and link.source_kind = 'simple'
        then simple.current_quantity
      end as physical_current,
      case
        when conflict.product_id is null and link.source_kind = 'simple'
        then simple.low_stock_threshold
      end as low_stock_threshold,
      coalesce(offer.advertised_offers, 0) as advertised_offers,
      coalesce(offer.active_offers, 0) as active_offers,
      case when offer.product_id is not null then offer.advertised_available end as advertised_available,
      coalesce(full_stock.inventory_count, 0) > 0 as full_applicable,
      coalesce(full_stock.inventory_count, 0) > 0
        and full_stock.checked_inventory_count = full_stock.inventory_count as full_ready,
      greatest(
        coalesce(full_stock.inventory_count, 0) - coalesce(full_stock.checked_inventory_count, 0),
        0
      ) as full_pending,
      coalesce(full_stock.has_zero, false) as full_has_zero,
      case when coalesce(full_stock.checked_inventory_count, 0) > 0 then full_stock.available_quantity end as full_available,
      coalesce(alert.open_alerts, 0) as open_alerts,
      alert.alert_severity,
      greatest(
        case when link.source_kind = 'simple' then simple.updated_at else kit.updated_at end,
        offer.updated_at,
        full_stock.updated_at,
        alert.updated_at
      ) as updated_at
    from candidate_products as product
    left join links as link on link.product_id = product.id
    left join conflicts as conflict on conflict.product_id = product.id
    left join simple_stock as simple on simple.sku_key = link.source_sku_key
    left join kit_stock as kit on kit.kit_sku_key = link.source_sku_key
    left join offer_totals as offer on offer.product_id = product.id
    left join full_totals as full_stock on full_stock.product_id = product.id
    left join alert_totals as alert on alert.product_id = product.id
  )
  select
    signal.product_id,
    signal.sku,
    signal.sku_key,
    signal.product_name,
    signal.mapping_status,
    signal.source_sku,
    signal.source_sku_key,
    signal.source_kind,
    signal.physical_ready,
    signal.physical_available,
    signal.physical_current,
    signal.low_stock_threshold,
    signal.advertised_offers,
    signal.active_offers,
    signal.advertised_available,
    signal.full_applicable,
    signal.full_ready,
    signal.full_pending,
    signal.full_has_zero,
    signal.full_available,
    signal.open_alerts,
    signal.alert_severity,
    case
      when signal.alert_severity = 'critical'
        or (signal.physical_ready and signal.physical_available = 0)
        or (signal.physical_ready and signal.physical_available > 0 and signal.full_has_zero)
      then 'critical'
      when signal.alert_severity = 'warning'
        or signal.mapping_status = 'conflict'
        or (signal.mapping_status = 'linked' and not signal.physical_ready)
        or (signal.full_applicable and not signal.full_ready)
        or (signal.active_offers > 0 and signal.advertised_available = 0)
      then 'warning'
      when signal.mapping_status = 'linked' and signal.physical_ready then 'healthy'
      else 'pending'
    end as operational_status,
    signal.updated_at
  from signals as signal;
end;
$$;

revoke all on function private.get_stock_product_signals(uuid, text)
from public, anon, authenticated;

create or replace function public.get_stock_overview_summary(
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

  with signals as materialized (
    select *
    from private.get_stock_product_signals(target_organization_id, '')
  )
  select jsonb_build_object(
    'totalProducts', count(*),
    'listedProducts', count(*) filter (where advertised_offers > 0),
    'mappedProducts', count(*) filter (where mapping_status = 'linked'),
    'conflictingProducts', count(*) filter (where mapping_status = 'conflict'),
    'physicalReadyProducts', count(*) filter (where physical_ready),
    'fullTrackedProducts', count(*) filter (where full_applicable),
    'attentionProducts', count(*) filter (where operational_status in ('critical', 'warning')),
    'openAlerts', coalesce(sum(open_alerts), 0),
    'sourceConnected', (
      exists (
        select 1 from public.upseller_stock_states as state
        where state.organization_id = target_organization_id
      )
      or exists (
        select 1 from public.product_inventory_links as link
        where link.organization_id = target_organization_id and link.is_active
      )
      or exists (
        select 1 from public.product_inventory_link_conflicts as conflict
        where conflict.organization_id = target_organization_id and conflict.is_current
      )
    ),
    'stockReceiptReady', true,
    'warehouses', coalesce((
      select jsonb_agg(
        jsonb_build_object('key', warehouse.warehouse_key, 'name', warehouse.warehouse_name)
        order by warehouse.warehouse_name, warehouse.warehouse_key
      )
      from (
        select distinct state.warehouse_key, state.warehouse_name
        from public.upseller_stock_states as state
        where state.organization_id = target_organization_id
      ) as warehouse
    ), '[]'::jsonb)
  ) into result
  from signals;

  return result;
end;
$$;

create or replace function public.get_stock_overview_page(
  target_organization_id uuid,
  search_query text default '',
  status_filter text default 'all',
  result_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  safe_limit integer := least(greatest(coalesce(result_limit, 200), 1), 200);
  safe_status text := lower(btrim(coalesce(status_filter, 'all')));
  result jsonb;
begin
  if not private.is_organization_member(target_organization_id) then
    raise exception 'not_authorized';
  end if;

  if safe_status not in ('all', 'attention', 'unmapped', 'conflicts', 'ready', 'full', 'kits') then
    raise exception 'invalid_stock_filter';
  end if;

  with signals as materialized (
    select *
    from private.get_stock_product_signals(target_organization_id, search_query)
  ),
  matching as materialized (
    select
      signal.*,
      count(*) over ()::bigint as match_count
    from signals as signal
    where safe_status = 'all'
      or (safe_status = 'attention' and signal.operational_status in ('critical', 'warning'))
      or (safe_status = 'unmapped' and signal.mapping_status = 'missing')
      or (safe_status = 'conflicts' and signal.mapping_status = 'conflict')
      or (safe_status = 'ready' and signal.physical_ready)
      or (safe_status = 'full' and signal.full_applicable)
      or (safe_status = 'kits' and signal.source_kind = 'kit')
  ),
  selected as materialized (
    select *
    from matching
    order by
      case operational_status
        when 'critical' then 1
        when 'warning' then 2
        when 'pending' then 3
        else 4
      end,
      sku_key,
      product_id
    limit safe_limit
  ),
  accessible_accounts as materialized (
    select account.id, account.code, account.display_name
    from public.ml_accounts as account
    where account.organization_id = target_organization_id
      and private.can_access_ml_account(account.id)
  ),
  selected_offers as materialized (
    select listing.product_id, listing.ml_account_id, listing.inventory_id
    from public.ml_listings as listing
    join accessible_accounts as account on account.id = listing.ml_account_id
    join selected on selected.product_id = listing.product_id
    where listing.organization_id = target_organization_id
      and listing.is_current
      and listing.product_id is not null
      and listing.inventory_id is not null

    union

    select variation.product_id, variation.ml_account_id, variation.inventory_id
    from public.ml_listing_variations as variation
    join accessible_accounts as account on account.id = variation.ml_account_id
    join selected on selected.product_id = variation.product_id
    where variation.organization_id = target_organization_id
      and variation.is_current
      and variation.product_id is not null
      and variation.inventory_id is not null
  ),
  full_accounts as materialized (
    select
      target.product_id,
      target.ml_account_id,
      account.code,
      account.display_name,
      count(*)::bigint as inventory_count,
      count(state.inventory_id)::bigint as checked_inventory_count,
      sum(state.available_quantity)::bigint as available_quantity
    from selected_offers as target
    join accessible_accounts as account on account.id = target.ml_account_id
    left join public.ml_fulfillment_stock_states as state
      on state.organization_id = target_organization_id
     and state.ml_account_id = target.ml_account_id
     and state.inventory_id = target.inventory_id
    group by target.product_id, target.ml_account_id, account.code, account.display_name
  ),
  full_accounts_json as materialized (
    select
      full_account.product_id,
      jsonb_agg(
        jsonb_build_object(
          'accountId', full_account.ml_account_id,
          'accountCode', full_account.code,
          'accountName', coalesce(full_account.display_name, full_account.code, 'Conta Mercado Livre'),
          'available', case
            when full_account.checked_inventory_count > 0 then full_account.available_quantity
            else null
          end,
          'inventoryCount', full_account.inventory_count,
          'checkedInventoryCount', full_account.checked_inventory_count,
          'pendingInventoryCount', greatest(full_account.inventory_count - full_account.checked_inventory_count, 0),
          'ready', full_account.checked_inventory_count = full_account.inventory_count
        )
        order by coalesce(full_account.display_name, full_account.code), full_account.ml_account_id
      ) as accounts
    from full_accounts as full_account
    group by full_account.product_id
  ),
  page_rows as (
    select
      selected.*,
      coalesce(full_accounts_json.accounts, '[]'::jsonb) as full_accounts
    from selected
    left join full_accounts_json on full_accounts_json.product_id = selected.product_id
  )
  select jsonb_build_object(
    'matchCount', coalesce(max(page_rows.match_count), 0),
    'products', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', page_rows.product_id,
          'sku', page_rows.sku,
          'name', page_rows.product_name,
          'mappingStatus', page_rows.mapping_status,
          'sourceSku', page_rows.source_sku,
          'sourceKind', page_rows.source_kind,
          'physicalReady', page_rows.physical_ready,
          'physicalAvailable', page_rows.physical_available,
          'physicalCurrent', page_rows.physical_current,
          'lowStockThreshold', page_rows.low_stock_threshold,
          'fullApplicable', page_rows.full_applicable,
          'fullReady', page_rows.full_ready,
          'fullPending', page_rows.full_pending,
          'fullAccounts', page_rows.full_accounts,
          'advertisedOffers', page_rows.advertised_offers,
          'activeOffers', page_rows.active_offers,
          'advertisedAvailable', page_rows.advertised_available,
          'openAlerts', page_rows.open_alerts,
          'alertSeverity', page_rows.alert_severity,
          'status', page_rows.operational_status,
          'updatedAt', page_rows.updated_at
        )
        order by
          case page_rows.operational_status
            when 'critical' then 1
            when 'warning' then 2
            when 'pending' then 3
            else 4
          end,
          page_rows.sku_key,
          page_rows.product_id
      ),
      '[]'::jsonb
    )
  ) into result
  from page_rows;

  return result;
end;
$$;

create or replace function public.get_products_overview_data(
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
  result jsonb;
begin
  if not private.is_organization_member(target_organization_id) then
    raise exception 'not_authorized';
  end if;

  if safe_status not in ('all', 'with_sales', 'without_sales', 'alerts', 'unmapped', 'conflicts', 'full') then
    raise exception 'invalid_products_filter';
  end if;

  with accessible_accounts as materialized (
    select account.id, account.code, account.display_name
    from public.ml_accounts as account
    where account.organization_id = target_organization_id
      and private.can_access_ml_account(account.id)
  ),
  all_offers as materialized (
    select
      'listing:' || listing.id::text as offer_key,
      listing.product_id,
      listing.ml_account_id,
      listing.status,
      listing.inventory_id
    from public.ml_listings as listing
    join accessible_accounts as account on account.id = listing.ml_account_id
    where listing.organization_id = target_organization_id
      and listing.is_current
      and listing.product_id is not null

    union all

    select
      'variation:' || variation.id::text,
      variation.product_id,
      variation.ml_account_id,
      listing.status,
      variation.inventory_id
    from public.ml_listing_variations as variation
    join accessible_accounts as account on account.id = variation.ml_account_id
    join public.ml_listings as listing
      on listing.organization_id = variation.organization_id
     and listing.ml_account_id = variation.ml_account_id
     and listing.id = variation.ml_listing_id
    where variation.organization_id = target_organization_id
      and variation.is_current
      and variation.product_id is not null
  ),
  sales_30 as materialized (
    select
      metric.product_id,
      sum(metric.units_sold)::bigint as units_sold,
      sum(metric.gross_revenue)::numeric as gross_revenue
    from public.daily_product_metrics as metric
    join accessible_accounts as account on account.id = metric.ml_account_id
    where metric.organization_id = target_organization_id
      and metric.metric_date >= current_date - 30
      and metric.metric_date < current_date
    group by metric.product_id
  ),
  overview_summary as materialized (
    select jsonb_build_object(
      'totalProducts', (
        select count(*) from public.products as product
        where product.organization_id = target_organization_id
      ),
      'activeProducts', count(distinct offer.product_id) filter (where offer.status = 'active'),
      'unitsSold30', coalesce((select sum(sales.units_sold) from sales_30 as sales), 0),
      'grossRevenue30', coalesce((select sum(sales.gross_revenue) from sales_30 as sales), 0)
    ) as summary
    from all_offers as offer
  ),
  signals as materialized (
    select *
    from private.get_stock_product_signals(target_organization_id, search_query)
  ),
  offer_totals as materialized (
    select
      offer.product_id,
      count(*) filter (where offer.status = 'active')::bigint as active_listings
    from all_offers as offer
    join signals as signal on signal.product_id = offer.product_id
    group by offer.product_id
  ),
  account_rows as materialized (
    select distinct
      offer.product_id,
      account.id,
      account.code,
      account.display_name
    from all_offers as offer
    join signals as signal on signal.product_id = offer.product_id
    join accessible_accounts as account on account.id = offer.ml_account_id
  ),
  account_totals as materialized (
    select
      account_row.product_id,
      jsonb_agg(
        jsonb_build_object(
          'id', account_row.id,
          'code', account_row.code,
          'name', account_row.display_name
        )
        order by account_row.display_name, account_row.code, account_row.id
      ) as accounts
    from account_rows as account_row
    group by account_row.product_id
  ),
  prices as materialized (
    select
      price.product_id,
      min(price.effective_price) as minimum_price,
      max(price.effective_price) as maximum_price
    from public.ml_offer_price_states as price
    join accessible_accounts as account on account.id = price.ml_account_id
    join signals as signal on signal.product_id = price.product_id
    where price.organization_id = target_organization_id
      and price.product_id is not null
      and price.effective_price is not null
    group by price.product_id
  ),
  enriched as materialized (
    select
      signal.*,
      coalesce(offer.active_listings, 0) as active_listings,
      coalesce(account.accounts, '[]'::jsonb) as accounts,
      coalesce(sales.units_sold, 0) as units_sold_30,
      coalesce(sales.gross_revenue, 0) as gross_revenue_30,
      price.minimum_price,
      price.maximum_price,
      case
        when signal.mapping_status = 'conflict' then 'conflict'
        when signal.mapping_status = 'missing' then 'missing'
        when signal.operational_status = 'critical' then 'critical'
        when signal.open_alerts > 0 or signal.operational_status = 'warning' then 'attention'
        else 'healthy'
      end as commercial_status
    from signals as signal
    left join offer_totals as offer on offer.product_id = signal.product_id
    left join account_totals as account on account.product_id = signal.product_id
    left join sales_30 as sales on sales.product_id = signal.product_id
    left join prices as price on price.product_id = signal.product_id
  ),
  matching as materialized (
    select enriched.*, count(*) over ()::bigint as match_count
    from enriched
    where safe_status = 'all'
      or (safe_status = 'with_sales' and enriched.units_sold_30 > 0)
      or (safe_status = 'without_sales' and enriched.units_sold_30 = 0)
      or (safe_status = 'alerts' and enriched.open_alerts > 0)
      or (safe_status = 'unmapped' and enriched.mapping_status = 'missing')
      or (safe_status = 'conflicts' and enriched.mapping_status = 'conflict')
      or (safe_status = 'full' and enriched.full_applicable)
  ),
  selected as materialized (
    select *
    from matching
    order by
      case commercial_status
        when 'critical' then 1
        when 'attention' then 2
        when 'conflict' then 3
        when 'missing' then 4
        else 5
      end,
      units_sold_30 desc,
      sku_key,
      product_id
    limit safe_limit
    offset safe_offset
  )
  select jsonb_build_object(
    'summary', (select summary from overview_summary),
    'matchCount', coalesce((select max(match_count) from matching), 0),
    'products', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', selected.product_id,
          'sku', selected.sku,
          'name', selected.product_name,
          'accounts', selected.accounts,
          'activeListings', selected.active_listings,
          'unitsSold30', selected.units_sold_30,
          'grossRevenue30', selected.gross_revenue_30,
          'minimumPrice', selected.minimum_price,
          'maximumPrice', selected.maximum_price,
          'physicalReady', selected.physical_ready,
          'physicalAvailable', selected.physical_available,
          'fullApplicable', selected.full_applicable,
          'fullAvailable', selected.full_available,
          'mappingStatus', selected.mapping_status,
          'openAlerts', selected.open_alerts,
          'alertSeverity', selected.alert_severity,
          'status', selected.commercial_status
        )
        order by
          case selected.commercial_status
            when 'critical' then 1
            when 'attention' then 2
            when 'conflict' then 3
            when 'missing' then 4
            else 5
          end,
          selected.units_sold_30 desc,
          selected.sku_key,
          selected.product_id
      )
      from selected
    ), '[]'::jsonb),
    'limit', safe_limit,
    'offset', safe_offset
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_stock_overview_summary(uuid) from public, anon;
revoke all on function public.get_stock_overview_page(uuid, text, text, integer) from public, anon;
revoke all on function public.get_products_overview_data(uuid, text, text, integer, integer) from public, anon;

grant execute on function public.get_stock_overview_summary(uuid) to authenticated;
grant execute on function public.get_stock_overview_page(uuid, text, text, integer) to authenticated;
grant execute on function public.get_products_overview_data(uuid, text, text, integer, integer) to authenticated;

