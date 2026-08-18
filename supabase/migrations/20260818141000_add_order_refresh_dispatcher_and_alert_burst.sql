-- ============================================================
-- Speed Bikers Gestao V2
--
-- ETAPA 32 — order_refresh dispatcher/cron, and raise operational
-- alert throughput now that the worker processes a burst of jobs per
-- invocation instead of one (see process-operational-alert-burst.ts).
-- ============================================================

-- Dedicated per-pipeline dispatcher, same shape as
-- dispatch_due_offer_refresh_workers: count due jobs, dispatch at most
-- 2 worker invocations per cron tick, do nothing when the queue is empty.
create or replace function private.dispatch_due_order_refresh_workers()
returns integer language plpgsql security definer set search_path = '' as $$
declare due_count integer; current_dispatch integer;
begin
  select least(count(*)::integer, 2)
  into due_count
  from public.ml_order_refresh_jobs
  where status in ('queued', 'running')
    and next_attempt_at <= now()
    and (lease_id is null or lease_expires_at <= now());

  due_count := coalesce(due_count, 0);

  for current_dispatch in 1..due_count loop
    perform private.dispatch_ml_sync_worker_task('order_refresh');
  end loop;

  return due_count;
end $$;

revoke all on function private.dispatch_due_order_refresh_workers()
from public, anon, authenticated, service_role;

do $$
declare job record;
begin
  for job in select jobid from cron.job where jobname = 'order-refresh-workers-every-minute'
  loop
    perform cron.unschedule(job.jobid);
  end loop;
end $$;

select cron.schedule(
  'order-refresh-workers-every-minute',
  '* * * * *',
  $$select private.dispatch_due_order_refresh_workers();$$
);

-- Operational alerts: dispatch_due_stock_workers's signature is unchanged
-- (still used by upseller_import/fulfillment_stock_backfill/
-- fulfillment_stock_refresh) — only the `maximum` argument for
-- operational_alerts drops from 4 requests/minute (1 job each) to 2
-- requests/minute (up to 20 jobs each, via processOperationalAlertBurst).
do $$
declare job record;
begin
  for job in select jobid from cron.job where jobname = 'operational-alert-workers-every-minute'
  loop
    perform cron.unschedule(job.jobid);
  end loop;
end $$;

select cron.schedule(
  'operational-alert-workers-every-minute',
  '* * * * *',
  $$select private.dispatch_due_stock_workers('operational_alerts', 2);$$
);
