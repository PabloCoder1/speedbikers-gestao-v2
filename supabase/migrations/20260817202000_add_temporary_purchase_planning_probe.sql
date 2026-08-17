-- ============================================================
-- HARNESS TEMPORÁRIO DE VERIFICAÇÃO — REMOVIDO NA MIGRATION SEGUINTE
-- ============================================================
--
-- private.get_purchase_planning_signals é plpgsql com RETURN QUERY: a
-- compatibilidade entre as 28 colunas de RETURNS TABLE e o SELECT final
-- só é validada em EXECUÇÃO, não na criação. Como as funções públicas
-- exigem auth.uid() (via is_organization_member), nenhuma automação
-- consegue executá-las, e a rota /compras iria a produção sem nunca ter
-- rodado uma vez.
--
-- Esta função existe apenas para essa verificação. Ela é concedida
-- somente a service_role, que já lê todas as tabelas envolvidas por
-- bypass de RLS — portanto não concede nenhum privilégio novo. anon e
-- authenticated não recebem grant.
--
-- A migration 20260817203000 a remove logo em seguida.

create or replace function public.probe_purchase_planning(
  target_organization_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'rows', count(*),
    'urgent', count(*) filter (where signal.status = 'urgent'),
    'due', count(*) filter (where signal.status = 'due'),
    'covered', count(*) filter (where signal.status = 'covered'),
    'noSales', count(*) filter (where signal.status = 'no_sales'),
    'insufficientData', count(*) filter (where signal.status = 'insufficient_data'),
    'mappingIssue', count(*) filter (where signal.status = 'mapping_issue'),
    'suggestedUnits', coalesce(sum(signal.suggested_purchase_quantity), 0),
    'skusWithKitDemand', count(*) filter (where signal.kit_units_consumed_30 > 0),
    'skusWithoutCost', count(*) filter (
      where signal.status in ('urgent', 'due') and signal.unit_cost is null
    ),
    'leadTime90', count(*) filter (where signal.lead_time_days = 90),
    'leadTime15', count(*) filter (where signal.lead_time_days = 15),
    'sample', (
      select jsonb_agg(to_jsonb(row))
      from (
        select
          inner_signal.source_sku,
          inner_signal.brand,
          inner_signal.physical_available,
          inner_signal.purchase_in_transit,
          inner_signal.low_stock_threshold,
          inner_signal.direct_units_sold_30,
          inner_signal.kit_units_consumed_30,
          inner_signal.physical_units_consumed_30,
          inner_signal.avg_daily_sales_30,
          inner_signal.sales_velocity_ready,
          inner_signal.lead_time_days,
          inner_signal.demand_during_lead_time,
          inner_signal.target_reserve,
          inner_signal.projected_stock_at_arrival,
          inner_signal.suggested_purchase_quantity,
          inner_signal.status,
          inner_signal.source_products_count
        from private.get_purchase_planning_signals(target_organization_id) as inner_signal
        order by
          case inner_signal.status when 'urgent' then 1 when 'due' then 2 else 3 end,
          inner_signal.suggested_purchase_quantity desc nulls last
        limit 8
      ) as row
    )
  )
  from private.get_purchase_planning_signals(target_organization_id) as signal;
$$;

revoke all on function public.probe_purchase_planning(uuid)
from public, anon, authenticated;
