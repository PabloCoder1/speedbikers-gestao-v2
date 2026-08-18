-- ============================================================
-- Hotfix — proteger leituras da carga de background
--
-- Parte E: adiciona periodicQueued/eventQueued dentro de `alerts` no
-- health RPC — mesma passagem de agregação já existente sobre
-- operational_alert_jobs (só mais duas colunas `count(*) filter`),
-- sem custo adicional relevante. Resto do corpo idêntico a
-- 20260818143000_add_operational_runtime_health.sql.
-- ============================================================

create or replace function public.get_operational_runtime_health(
  target_organization_id uuid
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  caller_role text := coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '');
  backend_status jsonb;
  purchase_summary jsonb;
  orders_by_account jsonb;
  order_notifications jsonb;
  alert_jobs jsonb;
  deductions_row record;
  result jsonb;
begin
  if caller_role <> 'service_role' then
    raise exception 'not_authorized';
  end if;

  backend_status := public.get_stock_backend_status(target_organization_id);

  with signals as materialized (
    select * from private.get_purchase_planning_signals(target_organization_id)
  )
  select jsonb_build_object(
    'monitoredSkus', count(*),
    'needPurchase', count(*) filter (where signal.status in ('urgent', 'due')),
    'urgent', count(*) filter (where signal.status = 'urgent'),
    'suggestedUnits', coalesce(sum(signal.suggested_purchase_quantity), 0),
    'estimatedPurchaseValue', coalesce(sum(signal.estimated_purchase_value), 0),
    'skusWithoutCost', count(*) filter (
      where signal.status in ('urgent', 'due') and signal.unit_cost is null
    ),
    'insufficientData', count(*) filter (where signal.status = 'insufficient_data'),
    'mappingIssues', count(*) filter (where signal.status = 'mapping_issue')
  )
  into purchase_summary
  from signals as signal;

  select coalesce(jsonb_agg(account_health order by account_health ->> 'code'), '[]'::jsonb)
  into orders_by_account
  from (
    select jsonb_build_object(
      'code', account.code,
      'lastRecentSuccessAt', (
        select max(run.finished_at) from public.sync_runs as run
        where run.organization_id = target_organization_id and run.ml_account_id = account.id
          and run.sync_type in ('orders_recent', 'orders_backfill') and run.status = 'succeeded'
      ),
      'lastRecentAttemptAt', (
        select max(run.started_at) from public.sync_runs as run
        where run.organization_id = target_organization_id and run.ml_account_id = account.id
          and run.sync_type in ('orders_recent', 'orders_backfill')
      ),
      'latestImportedOrderAt', (
        select max(order_row.date_created) from public.orders as order_row
        where order_row.organization_id = target_organization_id and order_row.ml_account_id = account.id
      ),
      'freshnessMinutes', (
        select round(extract(epoch from (now() - max(order_row.date_created))) / 60.0, 1)
        from public.orders as order_row
        where order_row.organization_id = target_organization_id and order_row.ml_account_id = account.id
      ),
      'lastErrorCode', (
        select run.error_code from public.sync_runs as run
        where run.organization_id = target_organization_id and run.ml_account_id = account.id
          and run.sync_type in ('orders_recent', 'orders_backfill') and run.error_code is not null
        order by run.started_at desc limit 1
      ),
      'lastErrorAt', (
        select run.finished_at from public.sync_runs as run
        where run.organization_id = target_organization_id and run.ml_account_id = account.id
          and run.sync_type in ('orders_recent', 'orders_backfill') and run.error_code is not null
        order by run.started_at desc limit 1
      ),
      'rateLimited24h', (
        select count(*) from public.sync_runs as run
        where run.organization_id = target_organization_id and run.ml_account_id = account.id
          and run.sync_type in ('orders_recent', 'orders_backfill')
          and run.started_at >= now() - interval '24 hours'
          and (run.error_code = 'orders_rate_limited' or run.error_message ilike '%429%')
      ) + (
        select count(*) from public.ml_order_refresh_jobs as job
        where job.organization_id = target_organization_id and job.ml_account_id = account.id
          and job.updated_at >= now() - interval '24 hours'
          and job.error_message ilike '%429%'
      )
    ) as account_health
    from public.ml_accounts as account
    where account.organization_id = target_organization_id
  ) as accounts;

  select jsonb_build_object(
    'queued', count(*) filter (where status = 'queued'),
    'running', count(*) filter (where status = 'running'),
    'failed', count(*) filter (where status = 'failed'),
    'oldestQueuedAt', min(created_at) filter (where status = 'queued'),
    'lastReceivedAt', max(last_notified_at)
  )
  into order_notifications
  from public.ml_order_refresh_jobs
  where organization_id = target_organization_id;

  -- periodicQueued/eventQueued: mesma varredura de operational_alert_jobs
  -- que já existia, só mais duas colunas `count(*) filter` — sem passo
  -- extra sobre a tabela.
  select jsonb_build_object(
    'queued', count(*) filter (where status = 'queued'),
    'running', count(*) filter (where status = 'running'),
    'failed', count(*) filter (where status = 'failed'),
    'oldestQueuedAt', min(created_at) filter (where status = 'queued'),
    'periodicQueued', count(*) filter (where status = 'queued' and reason = 'periodic_reconcile'),
    'eventQueued', count(*) filter (where status = 'queued' and reason <> 'periodic_reconcile')
  )
  into alert_jobs
  from public.operational_alert_jobs
  where organization_id = target_organization_id;

  select count(*) as row_count, coalesce(sum(quantity), 0) as sum_quantity, max(last_sale_at) as max_last_sale_at
  into deductions_row
  from public.stock_sale_deductions
  where organization_id = target_organization_id;

  result := jsonb_build_object(
    'orders', orders_by_account,
    'orderNotifications', order_notifications,
    'alerts', jsonb_build_object(
      'open', backend_status -> 'alerts' -> 'open',
      'critical', backend_status -> 'alerts' -> 'critical',
      'queued', alert_jobs -> 'queued',
      'running', alert_jobs -> 'running',
      'failed', alert_jobs -> 'failed',
      'oldestQueuedAt', alert_jobs -> 'oldestQueuedAt',
      'periodicQueued', alert_jobs -> 'periodicQueued',
      'eventQueued', alert_jobs -> 'eventQueued'
    ),
    'mapping', jsonb_build_object(
      'linked', backend_status -> 'upseller' -> 'mappedProducts',
      'conflict', backend_status -> 'upseller' -> 'conflictingProductLinks',
      'missingOperational', backend_status -> 'upseller' -> 'missingProductLinks'
    ),
    'full', jsonb_build_object(
      'targets', backend_status -> 'full' -> 'inventoryTargets',
      'checked', backend_status -> 'full' -> 'checked',
      'pending', backend_status -> 'full' -> 'pending'
    ),
    'prices', jsonb_build_object(
      'ready', backend_status -> 'upseller' -> 'physicalReadyProducts',
      'missing', backend_status -> 'upseller' -> 'physicalUnknownProducts'
    ),
    'purchase', purchase_summary,
    'stockSaleDeductions', jsonb_build_object(
      'rows', deductions_row.row_count,
      'sumQuantity', deductions_row.sum_quantity,
      'maxLastSaleAt', deductions_row.max_last_sale_at
    )
  );

  return result;
end $$;

revoke all on function public.get_operational_runtime_health(uuid)
from public, anon, authenticated;
grant execute on function public.get_operational_runtime_health(uuid)
to service_role;
