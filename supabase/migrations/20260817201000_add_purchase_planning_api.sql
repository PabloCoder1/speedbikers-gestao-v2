-- ============================================================
-- API PÚBLICA DO PLANEJAMENTO DE COMPRA
-- ============================================================
--
-- Sobre private.get_purchase_planning_signals (migration anterior).
--
-- Duas funções, pelo mesmo motivo aprendido em /estoque e /produtos: o
-- summary é barato e global, a página filtra, ordena e limita ANTES de
-- serializar. Máximo de 100 linhas por chamada. Nada de JSON gigante.

create or replace function public.get_purchase_planning_summary(
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
    select * from private.get_purchase_planning_signals(target_organization_id)
  )
  select jsonb_build_object(
    'monitoredSkus', count(*),
    'needPurchase', count(*) filter (where signal.status in ('urgent', 'due')),
    'urgent', count(*) filter (where signal.status = 'urgent'),
    'suggestedUnits', coalesce(sum(signal.suggested_purchase_quantity), 0),
    -- Soma apenas SKUs com custo conhecido; skusWithoutCost expõe a
    -- lacuna em vez de fingir precisão.
    'estimatedPurchaseValue', coalesce(sum(signal.estimated_purchase_value), 0),
    'skusWithoutCost', count(*) filter (
      where signal.status in ('urgent', 'due') and signal.unit_cost is null
    ),
    'insufficientData', count(*) filter (where signal.status = 'insufficient_data'),
    'mappingIssues', count(*) filter (where signal.status = 'mapping_issue'),
    'periodFrom', ((now() at time zone 'America/Sao_Paulo')::date - 30),
    'periodTo', ((now() at time zone 'America/Sao_Paulo')::date - 1)
  ) into result
  from signals as signal;

  return result;
end;
$$;

create or replace function public.get_purchase_planning_page(
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

revoke all on function public.get_purchase_planning_summary(uuid)
from public, anon;
revoke all on function public.get_purchase_planning_page(uuid, text, text, integer, integer)
from public, anon;

grant execute on function public.get_purchase_planning_summary(uuid)
to authenticated;
grant execute on function public.get_purchase_planning_page(uuid, text, text, integer, integer)
to authenticated;
