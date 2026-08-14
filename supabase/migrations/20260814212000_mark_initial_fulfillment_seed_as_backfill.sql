-- Runs created by the first inventory_id seed are backfills. Daily runs created
-- after this migration keep the reconcile provenance defined by the scheduler.
update public.sync_runs
set metadata = jsonb_set(metadata, '{mode}', '"backfill"'::jsonb, true)
where sync_type = 'fulfillment_stock_backfill'
  and status = 'queued'
  and records_processed = 0
  and coalesce(metadata ->> 'mode', '') = 'reconcile'
  and started_at <= now();
