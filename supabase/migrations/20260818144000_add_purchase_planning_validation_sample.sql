-- ============================================================
-- Speed Bikers Gestao V2
--
-- ETAPA 32 — validação de /compras. Nenhuma fórmula nova: esta função
-- só seleciona uma amostra diversificada a partir de
-- private.get_purchase_planning_signals (a mesma fonte de
-- get_purchase_planning_summary/_page), com os mesmos campos que
-- get_purchase_planning_page já expõe. O objetivo é permitir comparar
-- o suggested_purchase_quantity/status calculado em SQL contra
-- calculatePurchaseRecommendation() em TypeScript, linha a linha.
--
-- Ferramenta de auditoria, sem UI: service_role apenas. Reaproveita o
-- bypass de caller_role = 'service_role' que
-- get_purchase_planning_signals já suporta (20260818114954).
--
-- Fica em public (não private) porque precisa ser chamável via
-- supabase.rpc(...) a partir do script/teste de validação — o schema
-- private não é exposto pelo PostgREST.
-- ============================================================

create or replace function public.get_purchase_planning_validation_sample(
  target_organization_id uuid,
  sample_size integer default 20
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  caller_role text := coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '');
  safe_sample_size integer := least(greatest(coalesce(sample_size, 20), 1), 200);
  result jsonb;
begin
  if caller_role <> 'service_role' then
    raise exception 'not_authorized';
  end if;

  with signals as materialized (
    select * from private.get_purchase_planning_signals(target_organization_id)
  ),
  categorized as (
    (select signals.*, 'urgent_imported' as category from signals
      where status = 'urgent' and lead_time_days = 90
      order by suggested_purchase_quantity desc nulls last limit 3)
    union all
    (select signals.*, 'urgent_domestic' from signals
      where status = 'urgent' and lead_time_days = 15
      order by suggested_purchase_quantity desc nulls last limit 3)
    union all
    (select signals.*, 'purchase_in_transit' from signals
      where coalesce(purchase_in_transit, 0) > 0 limit 3)
    union all
    (select signals.*, 'kit_consumption' from signals
      where coalesce(kit_units_consumed_30, 0) > 0 limit 3)
    union all
    (select signals.*, 'zero_suggested_with_sales' from signals
      where coalesce(suggested_purchase_quantity, 0) = 0
        and coalesce(direct_units_sold_30, 0) + coalesce(kit_units_consumed_30, 0) > 0
      limit 3)
    union all
    (select signals.*, 'no_sales' from signals where status = 'no_sales' limit 2)
    union all
    (select signals.*, 'insufficient_data' from signals where status = 'insufficient_data' limit 2)
    union all
    (select signals.*, 'no_cost' from signals
      where unit_cost is null and status in ('urgent', 'due') limit 2)
    union all
    -- Estas duas escalam com sample_size deliberadamente: quando o
    -- script de validação chama com sample_size alto (ex. 200), o
    -- relatório de outliers ("top 20 por quantidade sugerida" / "top
    -- 20 por valor estimado") precisa de mais do que 3 linhas por
    -- categoria. Nenhuma fórmula muda — só o limite de seleção.
    (select signals.*, 'top_suggested' from signals
      order by suggested_purchase_quantity desc nulls last
      limit greatest(3, safe_sample_size / 4))
    union all
    (select signals.*, 'top_value' from signals
      order by estimated_purchase_value desc nulls last
      limit greatest(3, safe_sample_size / 4))
    union all
    (select signals.*, 'sku_13014' from signals where source_sku = '13014' limit 1)
  ),
  deduped as (
    select distinct on (source_sku_key) categorized.*
    from categorized
    order by source_sku_key, category
  ),
  final_sample as (
    select * from deduped limit safe_sample_size
  )
  select jsonb_build_object(
    'sampleSize', (select count(*) from final_sample),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sourceSku', item.source_sku,
        'sourceSkuKey', item.source_sku_key,
        'title', item.title,
        'brand', item.brand,
        'category', item.category,
        'physicalAvailable', item.physical_available,
        'physicalCurrent', item.physical_current,
        'purchaseInTransit', item.purchase_in_transit,
        'transferInTransit', item.transfer_in_transit,
        'lowStockThreshold', item.low_stock_threshold,
        'directUnitsSold30', item.direct_units_sold_30,
        'kitUnitsConsumed30', item.kit_units_consumed_30,
        'physicalUnitsConsumed30', item.physical_units_consumed_30,
        'avgDailySales30', item.avg_daily_sales_30,
        'salesVelocityReady', item.sales_velocity_ready,
        'leadTimeDays', item.lead_time_days,
        'demandDuringLeadTime', item.demand_during_lead_time,
        'targetReserve', item.target_reserve,
        'projectedStockAtArrival', item.projected_stock_at_arrival,
        'suggestedPurchaseQuantity', item.suggested_purchase_quantity,
        'status', item.status,
        'planningIssue', item.planning_issue,
        'sourceProductsCount', item.source_products_count,
        'unitCost', item.unit_cost,
        'estimatedPurchaseValue', item.estimated_purchase_value
      ))
      from final_sample as item
    ), '[]'::jsonb)
  )
  into result;

  return result;
end $$;

revoke all on function public.get_purchase_planning_validation_sample(uuid, integer)
from public, anon, authenticated;
grant execute on function public.get_purchase_planning_validation_sample(uuid, integer)
to service_role;
