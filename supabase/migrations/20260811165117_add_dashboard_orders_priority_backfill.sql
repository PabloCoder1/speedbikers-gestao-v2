-- ============================================================
-- Speed Bikers Gestão V2
-- Priority dashboard orders backfill
-- ============================================================


-- ------------------------------------------------------------
-- 1. ONLY ONE ACTIVE DASHBOARD BACKFILL PER ACCOUNT
-- ------------------------------------------------------------

create unique index
if not exists sync_runs_one_active_dashboard_orders_idx

on public.sync_runs (
  ml_account_id
)

where
  sync_type =
    'orders_dashboard_backfill'

  and status in (
    'queued',
    'running'
  );


create index
if not exists sync_runs_dashboard_orders_queue_idx

on public.sync_runs (
  status,
  next_attempt_at,
  started_at
)

where
  sync_type =
    'orders_dashboard_backfill'

  and status in (
    'queued',
    'running'
  );


-- ------------------------------------------------------------
-- 2. CLAIM PRIORITY DASHBOARD JOB
-- ------------------------------------------------------------

create or replace function
public.claim_next_orders_dashboard_backfill_run(
  requested_lease_id uuid,
  lease_duration_seconds integer default 180
)

returns uuid

language plpgsql
security definer
set search_path = ''

as $$
declare
  claimed_run_id uuid;
begin

  if requested_lease_id is null then
    raise exception
      'lease_id_required';
  end if;


  if (
    lease_duration_seconds < 30
    or
    lease_duration_seconds > 300
  ) then
    raise exception
      'invalid_lease_duration';
  end if;


  with candidate as (
    select
      sync_run.id

    from public.sync_runs
      as sync_run

    where
      sync_run.sync_type =
        'orders_dashboard_backfill'

      and sync_run.status in (
        'queued',
        'running'
      )

      and sync_run.next_attempt_at
        <= now()

      and (
        sync_run.lease_id is null

        or

        sync_run.lease_expires_at
          <= now()
      )

    order by
      sync_run.started_at asc

    for update
      skip locked

    limit 1
  )

  update public.sync_runs
    as sync_run

  set
    status =
      'running',

    lease_id =
      requested_lease_id,

    lease_expires_at =
      now()
      + make_interval(
          secs =>
            lease_duration_seconds
        )

  from candidate

  where sync_run.id =
    candidate.id

  returning sync_run.id
  into claimed_run_id;


  return claimed_run_id;
end;
$$;


revoke all
on function
public.claim_next_orders_dashboard_backfill_run(
  uuid,
  integer
)
from public;


revoke all
on function
public.claim_next_orders_dashboard_backfill_run(
  uuid,
  integer
)
from anon;


revoke all
on function
public.claim_next_orders_dashboard_backfill_run(
  uuid,
  integer
)
from authenticated;


grant execute
on function
public.claim_next_orders_dashboard_backfill_run(
  uuid,
  integer
)
to service_role;