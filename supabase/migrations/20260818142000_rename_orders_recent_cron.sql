-- ============================================================
-- Speed Bikers Gestao V2
--
-- ETAPA 32 — orders_recent becomes the safety-net reconciliation path
-- now that orders_v2 notifications carry primary freshness. Same
-- 5-minute interval, one account per execution, unchanged logic in
-- syncRecentOrdersIfDue — only the misleading cron name changes.
-- ============================================================

do $$
declare job record;
begin
  for job in select jobid from cron.job where jobname = 'ml-orders-recent-every-5-minutes'
  loop
    perform cron.unschedule(job.jobid);
  end loop;
end $$;

select cron.schedule(
  'ml-orders-recent-reconcile-every-5-minutes',
  '*/5 * * * *',
  $$select private.dispatch_ml_sync_worker_task('orders_recent');$$
);
