-- ============================================================
-- ETAPA 33 — pedidos internos entram no trânsito de compra.
-- ============================================================
--
-- private.get_purchase_planning_signals (última versão em
-- 20260818150000) usava só stock.purchase_in_transit (o campo
-- importado do UpSeller). Agora que purchase_orders existe, um pedido
-- interno "ordered"/"partially_received" com transit_accounting_source
-- = 'internal' representa unidades a caminho que o UpSeller ainda NÃO
-- reflete no seu próprio "Em Trânsito (Compra)" — precisam somar.
-- Pedidos 'upseller_confirmed' já estão na fotografia do UpSeller e
-- NÃO entram de novo (sem MAX mágico, sem heurística de sobreposição:
-- o operador decide explicitamente ao marcar o pedido como realizado).
--
-- purchase_in_transit continua sendo o contrato que a página consome
-- (evita quebrar UI existente) mas agora representa a soma efetiva.
-- Dois campos novos, upseller_purchase_in_transit e
-- internal_purchase_in_transit, expõem o detalhamento.
--
-- Fórmula em si (demanda no lead time + reserva - disponível -
-- trânsito) É A MESMA — só a composição do trânsito muda, exatamente
-- como pedido. Corpo idêntico a 20260818150000 fora dessa mudança.
--
-- Tipo de retorno muda (2 colunas novas): precisa dropar antes de
-- recriar.

drop function if exists public.get_purchase_planning_page(uuid, text, text, integer, integer);
drop function if exists private.get_purchase_planning_signals(uuid);

create function private.get_purchase_planning_signals(
  target_organization_id uuid
)
returns table (
  source_sku text,
  source_sku_key text,
  title text,
  brand text,
  physical_available numeric,
  physical_current numeric,
  occupied_quantity numeric,
  purchase_in_transit numeric,
  upseller_purchase_in_transit numeric,
  internal_purchase_in_transit numeric,
  transfer_in_transit numeric,
  low_stock_threshold numeric,
  direct_units_sold_30 numeric,
  kit_units_consumed_30 numeric,
  physical_units_consumed_30 numeric,
  avg_daily_sales_30 numeric,
  sales_velocity_ready boolean,
  coverage_days numeric,
  lead_time_days integer,
  demand_during_lead_time numeric,
  target_reserve numeric,
  projected_stock_at_arrival numeric,
  suggested_purchase_quantity numeric,
  status text,
  planning_issue text,
  source_products_count bigint,
  source_product_ids uuid[],
  unit_cost numeric,
  estimated_purchase_value numeric,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  period_to date := ((now() at time zone 'America/Sao_Paulo')::date - 1);
  period_from date := ((now() at time zone 'America/Sao_Paulo')::date - 30);
  caller_role text := coalesce(
    current_setting('request.jwt.claims', true)::json ->> 'role',
    ''
  );
  history_covered boolean;
begin
  if not (
    private.is_organization_member(target_organization_id)
    or caller_role = 'service_role'
  ) then
    raise exception 'not_authorized';
  end if;

  select bool_and(covered) into history_covered
  from (
    select exists (
      select 1
      from public.sync_runs as run
      where run.ml_account_id = account.id
        and run.sync_type = 'orders_dashboard_backfill'
        and run.status = 'succeeded'
        and (run.metadata ->> 'covered_from') <= period_from::text
    ) as covered
    from public.ml_accounts as account
    where account.organization_id = target_organization_id
      and account.is_active
      and account.connection_status = 'connected'
  ) as coverage;

  history_covered := coalesce(history_covered, false);

  return query
  with accessible_accounts as materialized (
    select account.id
    from public.ml_accounts as account
    where account.organization_id = target_organization_id
      and (caller_role = 'service_role' or private.can_access_ml_account(account.id))
  ),

  links as materialized (
    select link.product_id, link.source_sku, link.source_sku_key, link.source_kind
    from public.product_inventory_links as link
    where link.organization_id = target_organization_id
      and link.source = 'upseller'
      and link.is_active
      and not exists (
        select 1 from public.product_inventory_link_conflicts as conflict
        where conflict.organization_id = target_organization_id
          and conflict.product_id = link.product_id
          and conflict.source = 'upseller'
          and conflict.is_current
      )
  ),

  product_sales as materialized (
    select metric.product_id, sum(metric.units_sold)::numeric as units_sold_30
    from public.daily_product_metrics as metric
    join accessible_accounts as account on account.id = metric.ml_account_id
    where metric.organization_id = target_organization_id
      and metric.metric_date between period_from and period_to
    group by metric.product_id
  ),

  kit_reliability as materialized (
    select
      component.kit_sku_key,
      count(*) > 0
        and bool_and(component_state.sku_key is not null)
        and not bool_or(nested_kit.kit_sku_key is not null) as reliable
    from public.upseller_kit_components as component
    left join (
      select distinct state.sku_key
      from public.upseller_stock_states as state
      where state.organization_id = target_organization_id
    ) as component_state
      on component_state.sku_key = component.component_sku_key
    left join public.upseller_kits as nested_kit
      on nested_kit.organization_id = target_organization_id
     and nested_kit.kit_sku_key = component.component_sku_key
     and nested_kit.is_current
    where component.organization_id = target_organization_id
      and component.is_current
    group by component.kit_sku_key
  ),

  simple_demand as materialized (
    select link.source_sku_key, coalesce(sales.units_sold_30, 0) as direct_units,
           0::numeric as kit_units, link.product_id, null::text as planning_issue
    from links as link
    left join product_sales as sales on sales.product_id = link.product_id
    where link.source_kind = 'simple'
  ),

  kit_demand as materialized (
    select component.component_sku_key, 0::numeric,
           coalesce(sales.units_sold_30, 0) * component.required_quantity,
           link.product_id, null::text
    from links as link
    join kit_reliability as reliability
      on reliability.kit_sku_key = link.source_sku_key and reliability.reliable
    join public.upseller_kit_components as component
      on component.organization_id = target_organization_id
     and component.kit_sku_key = link.source_sku_key
     and component.is_current
    left join product_sales as sales on sales.product_id = link.product_id
    where link.source_kind = 'kit'
  ),

  unresolved_kit_demand as materialized (
    select link.source_sku_key, 0::numeric, 0::numeric, link.product_id,
           'kit_components_unknown'::text
    from links as link
    left join kit_reliability as reliability on reliability.kit_sku_key = link.source_sku_key
    where link.source_kind = 'kit' and coalesce(reliability.reliable, false) = false
  ),

  demand as materialized (
    select * from simple_demand
    union all select * from kit_demand
    union all select * from unresolved_kit_demand
  ),

  demand_by_sku as materialized (
    select
      demand.source_sku_key,
      sum(demand.direct_units) as direct_units_sold_30,
      sum(demand.kit_units) as kit_units_consumed_30,
      count(distinct demand.product_id)::bigint as source_products_count,
      array_agg(distinct demand.product_id) as source_product_ids,
      max(demand.planning_issue) as planning_issue
    from demand
    group by demand.source_sku_key
  ),

  receipt_adjustments as materialized (
    select adjustment.sku_key, adjustment.warehouse_key,
           sum(adjustment.quantity) as quantity, max(adjustment.applied_at) as applied_at
    from public.current_stock_receipt_adjustments as adjustment
    where adjustment.organization_id = target_organization_id
    group by adjustment.sku_key, adjustment.warehouse_key
  ),

  stock_by_sku as materialized (
    select
      state.sku_key,
      max(state.source_sku) as source_sku,
      max(state.title) as title,
      sum(state.available_quantity + coalesce(adjustment.quantity, 0))::numeric as available_quantity,
      sum(state.current_quantity + coalesce(adjustment.quantity, 0))::numeric as current_quantity,
      sum(state.occupied_quantity)::numeric as occupied_quantity,
      sum(state.purchase_in_transit)::numeric as purchase_in_transit,
      sum(state.transfer_in_transit)::numeric as transfer_in_transit,
      sum(state.low_stock_threshold)::numeric as low_stock_threshold,
      (case
        when bool_and(state.average_cost is not null) then
          case when sum(state.current_quantity) > 0
            then sum(state.average_cost * state.current_quantity) / sum(state.current_quantity)
            else avg(state.average_cost) end
      end)::numeric as average_cost,
      max(greatest(state.checked_at, adjustment.applied_at)) as updated_at
    from public.upseller_stock_states as state
    left join receipt_adjustments as adjustment
      on adjustment.sku_key = state.sku_key and adjustment.warehouse_key = state.warehouse_key
    where state.organization_id = target_organization_id
    group by state.sku_key
  ),

  catalog as materialized (
    select
      product_catalog.sku_key,
      max(product_catalog.brand) as brand,
      max(product_catalog.title) as title,
      max(product_catalog.source_sku) as source_sku,
      max(product_catalog.purchase_cost)::numeric as purchase_cost
    from public.upseller_product_catalog as product_catalog
    where product_catalog.organization_id = target_organization_id
    group by product_catalog.sku_key
  ),

  -- NOVO: outstanding de pedidos internos (ordered/partially_received,
  -- transit_accounting_source = 'internal') por SKU físico. Draft e
  -- approved nunca entram — um rascunho pode nunca virar compra real.
  -- upseller_confirmed nunca entra — já está na fotografia do UpSeller.
  internal_transit as materialized (
    select
      item.source_sku_key,
      sum(progress.outstanding_quantity) as internal_purchase_in_transit
    from public.purchase_order_items as item
    join public.purchase_orders as po
      on po.id = item.purchase_order_id
     and po.organization_id = item.organization_id
    join public.purchase_order_item_progress as progress
      on progress.purchase_order_item_id = item.id
    where item.organization_id = target_organization_id
      and po.status in ('ordered', 'partially_received')
      and po.transit_accounting_source = 'internal'
    group by item.source_sku_key
  ),

  scored as (
    select
      coalesce(stock.source_sku, catalog.source_sku, demand_by_sku.source_sku_key)::text as source_sku,
      demand_by_sku.source_sku_key::text as source_sku_key,
      coalesce(stock.title, catalog.title)::text as title,
      catalog.brand::text as brand,
      stock.available_quantity as physical_available,
      stock.current_quantity as physical_current,
      stock.occupied_quantity,
      coalesce(stock.purchase_in_transit, 0)::numeric as upseller_purchase_in_transit,
      coalesce(internal_transit.internal_purchase_in_transit, 0)::numeric as internal_purchase_in_transit,
      (
        coalesce(stock.purchase_in_transit, 0)
        + coalesce(internal_transit.internal_purchase_in_transit, 0)
      )::numeric as effective_purchase_in_transit,
      coalesce(stock.transfer_in_transit, 0)::numeric as transfer_in_transit,
      stock.low_stock_threshold,
      demand_by_sku.direct_units_sold_30,
      demand_by_sku.kit_units_consumed_30,
      (demand_by_sku.direct_units_sold_30 + demand_by_sku.kit_units_consumed_30)::numeric
        as physical_units_consumed_30,
      demand_by_sku.planning_issue,
      demand_by_sku.source_products_count,
      demand_by_sku.source_product_ids,
      private.purchase_lead_time_days(catalog.brand) as lead_time_days,
      greatest(coalesce(stock.low_stock_threshold, 0), 0)::numeric as target_reserve,
      coalesce(stock.average_cost, catalog.purchase_cost)::numeric as unit_cost,
      stock.updated_at,
      (
        history_covered
        and stock.available_quantity is not null
        and demand_by_sku.planning_issue is null
      ) as sales_velocity_ready,
      case
        when history_covered
        then round((demand_by_sku.direct_units_sold_30 + demand_by_sku.kit_units_consumed_30) / 30.0, 6)
      end as avg_daily_sales_30
    from demand_by_sku
    left join stock_by_sku as stock on stock.sku_key = demand_by_sku.source_sku_key
    left join catalog on catalog.sku_key = demand_by_sku.source_sku_key
    left join internal_transit on internal_transit.source_sku_key = demand_by_sku.source_sku_key
  ),

  final as (
    select scored.*,
      case
        when not scored.sales_velocity_ready then null
        when coalesce(scored.avg_daily_sales_30, 0) <= 0 then 0::numeric
        else ceil(greatest(0,
          (scored.avg_daily_sales_30 * scored.lead_time_days) + scored.target_reserve
          - scored.physical_available - scored.effective_purchase_in_transit))
      end as suggested
    from scored
  )

  select
    final.source_sku, final.source_sku_key, final.title, final.brand,
    final.physical_available, final.physical_current, final.occupied_quantity,
    final.effective_purchase_in_transit as purchase_in_transit,
    final.upseller_purchase_in_transit,
    final.internal_purchase_in_transit,
    final.transfer_in_transit, final.low_stock_threshold,
    final.direct_units_sold_30, final.kit_units_consumed_30, final.physical_units_consumed_30,
    final.avg_daily_sales_30, final.sales_velocity_ready,
    case when final.sales_velocity_ready and coalesce(final.avg_daily_sales_30, 0) > 0
         then final.physical_available / final.avg_daily_sales_30 end as coverage_days,
    final.lead_time_days,
    case when final.sales_velocity_ready and coalesce(final.avg_daily_sales_30, 0) > 0
         then final.avg_daily_sales_30 * final.lead_time_days
         when final.sales_velocity_ready then 0::numeric end as demand_during_lead_time,
    final.target_reserve,
    case when final.sales_velocity_ready and coalesce(final.avg_daily_sales_30, 0) > 0
         then final.physical_available + final.effective_purchase_in_transit
              - (final.avg_daily_sales_30 * final.lead_time_days)
         when final.sales_velocity_ready
         then final.physical_available + final.effective_purchase_in_transit end as projected_stock_at_arrival,
    final.suggested,
    case
      when final.planning_issue is not null then 'mapping_issue'
      when not final.sales_velocity_ready then 'insufficient_data'
      when coalesce(final.avg_daily_sales_30, 0) <= 0 then 'no_sales'
      when final.suggested > 0
        then case when final.physical_available <= 0 then 'urgent' else 'due' end
      else 'covered'
    end as status,
    final.planning_issue, final.source_products_count, final.source_product_ids,
    final.unit_cost,
    case when final.unit_cost is not null and coalesce(final.suggested, 0) > 0
         then final.unit_cost * final.suggested end as estimated_purchase_value,
    final.updated_at
  from final;
end;
$$;

revoke all on function private.get_purchase_planning_signals(uuid)
from public, anon, authenticated;
grant execute on function private.get_purchase_planning_signals(uuid) to service_role;

create function public.get_purchase_planning_page(
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

  if safe_status not in (
    'all', 'purchase', 'urgent', 'covered', 'no_sales',
    'insufficient_data', 'imported', 'domestic'
  ) then
    raise exception 'invalid_purchase_filter';
  end if;

  with signals as materialized (
    select * from private.get_purchase_planning_signals(target_organization_id)
  ),
  matching as materialized (
    select signal.*, count(*) over ()::bigint as match_count
    from signals as signal
    where (
      normalized_search = ''
      or position(normalized_search in lower(signal.source_sku)) > 0
      or position(normalized_search in lower(coalesce(signal.title, ''))) > 0
      or position(normalized_search in lower(coalesce(signal.brand, ''))) > 0
    )
    and (
      safe_status = 'all'
      or (safe_status = 'purchase' and signal.status in ('urgent', 'due'))
      or (safe_status = 'urgent' and signal.status = 'urgent')
      or (safe_status = 'covered' and signal.status = 'covered')
      or (safe_status = 'no_sales' and signal.status = 'no_sales')
      or (safe_status = 'insufficient_data'
          and signal.status in ('insufficient_data', 'mapping_issue'))
      or (safe_status = 'imported' and signal.lead_time_days = 90)
      or (safe_status = 'domestic' and signal.lead_time_days = 15)
    )
  ),
  selected as materialized (
    select *
    from matching
    order by
      case status
        when 'urgent' then 1
        when 'due' then 2
        when 'insufficient_data' then 3
        when 'mapping_issue' then 4
        when 'covered' then 5
        else 6
      end,
      suggested_purchase_quantity desc nulls last,
      coverage_days asc nulls last,
      source_sku
    limit safe_limit
    offset safe_offset
  )
  select jsonb_build_object(
    'matchCount', coalesce((select max(match_count) from matching), 0),
    'limit', safe_limit,
    'offset', safe_offset,
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'sourceSku', selected.source_sku,
          'sourceSkuKey', selected.source_sku_key,
          'title', selected.title,
          'brand', selected.brand,
          'physicalAvailable', selected.physical_available,
          'physicalCurrent', selected.physical_current,
          'occupiedQuantity', selected.occupied_quantity,
          'purchaseInTransit', selected.purchase_in_transit,
          'upsellerPurchaseInTransit', selected.upseller_purchase_in_transit,
          'internalPurchaseInTransit', selected.internal_purchase_in_transit,
          'transferInTransit', selected.transfer_in_transit,
          'lowStockThreshold', selected.low_stock_threshold,
          'directUnitsSold30', selected.direct_units_sold_30,
          'kitUnitsConsumed30', selected.kit_units_consumed_30,
          'physicalUnitsConsumed30', selected.physical_units_consumed_30,
          'avgDailySales30', selected.avg_daily_sales_30,
          'salesVelocityReady', selected.sales_velocity_ready,
          'coverageDays', selected.coverage_days,
          'leadTimeDays', selected.lead_time_days,
          'demandDuringLeadTime', selected.demand_during_lead_time,
          'targetReserve', selected.target_reserve,
          'projectedStockAtArrival', selected.projected_stock_at_arrival,
          'suggestedPurchaseQuantity', selected.suggested_purchase_quantity,
          'status', selected.status,
          'planningIssue', selected.planning_issue,
          'sourceProductsCount', selected.source_products_count,
          'sourceProductIds', to_jsonb(selected.source_product_ids),
          'unitCost', selected.unit_cost,
          'estimatedPurchaseValue', selected.estimated_purchase_value,
          'updatedAt', selected.updated_at
        )
        order by
          case selected.status
            when 'urgent' then 1
            when 'due' then 2
            when 'insufficient_data' then 3
            when 'mapping_issue' then 4
            when 'covered' then 5
            else 6
          end,
          selected.suggested_purchase_quantity desc nulls last,
          selected.coverage_days asc nulls last,
          selected.source_sku
      )
      from selected
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_purchase_planning_page(uuid, text, text, integer, integer)
from public, anon;
grant execute on function public.get_purchase_planning_page(uuid, text, text, integer, integer)
to authenticated;
