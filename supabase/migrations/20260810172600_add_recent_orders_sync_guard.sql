-- ============================================================
-- Speed Bikers Gestão V2
-- Recent orders synchronization guard
-- ============================================================

create unique index
if not exists sync_runs_one_running_orders_recent_idx

on public.sync_runs (
  ml_account_id
)

where
  sync_type =
    'orders_recent'

  and status =
    'running';