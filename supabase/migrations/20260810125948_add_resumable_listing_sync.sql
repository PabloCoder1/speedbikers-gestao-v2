-- ============================================================
-- Speed Bikers Gestão V2
-- Resumable Mercado Livre listing synchronization
-- ============================================================


-- ------------------------------------------------------------
-- 1. EXTEND SYNC RUNS
-- ------------------------------------------------------------

alter table public.sync_runs
drop constraint if exists sync_runs_status_check;

alter table public.sync_runs
add constraint sync_runs_status_check
check (
  status in (
    'queued',
    'running',
    'succeeded',
    'failed',
    'partial',
    'cancelled'
  )
);


alter table public.sync_runs
add column cursor_offset integer
not null default 0
check (
  cursor_offset >= 0
);


alter table public.sync_runs
add column batch_size integer
not null default 50
check (
  batch_size between 1 and 50
);


alter table public.sync_runs
add column retry_count integer
not null default 0
check (
  retry_count >= 0
);


alter table public.sync_runs
add column max_retries integer
not null default 5
check (
  max_retries between 0 and 20
);


alter table public.sync_runs
add column next_attempt_at timestamptz
not null default now();


alter table public.sync_runs
add column lease_id uuid;


alter table public.sync_runs
add column lease_expires_at timestamptz;


alter table public.sync_runs
add column requested_by uuid
references auth.users(id)
on delete set null;


alter table public.sync_runs
add column updated_at timestamptz
not null default now();


alter table public.sync_runs
add constraint sync_runs_lease_consistency
check (
  (
    lease_id is null
    and lease_expires_at is null
  )
  or
  (
    lease_id is not null
    and lease_expires_at is not null
  )
);


create trigger sync_runs_set_updated_at
before update on public.sync_runs
for each row
execute function private.set_updated_at();


-- ------------------------------------------------------------
-- 2. ONE ACTIVE FULL LISTING SYNC PER ACCOUNT
-- ------------------------------------------------------------

create unique index sync_runs_one_active_listings_full_idx
on public.sync_runs (
  ml_account_id
)
where
  sync_type = 'listings_full'
  and status in (
    'queued',
    'running'
  );


create index sync_runs_worker_queue_idx
on public.sync_runs (
  sync_type,
  status,
  next_attempt_at
)
where
  status in (
    'queued',
    'running'
  );


-- ------------------------------------------------------------
-- 3. ATOMIC JOB CLAIM
--
-- FOR UPDATE SKIP LOCKED prevents two workers from claiming
-- the same synchronization simultaneously.
-- ------------------------------------------------------------

create or replace function public.claim_next_listings_sync_run(
  requested_lease_id uuid,
  lease_duration_seconds integer default 120
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
    raise exception 'lease_id_required';
  end if;

  if (
    lease_duration_seconds < 30
    or lease_duration_seconds > 300
  ) then
    raise exception 'invalid_lease_duration';
  end if;

  with candidate as (
    select sync_run.id
    from public.sync_runs as sync_run

    where sync_run.sync_type =
      'listings_full'

      and sync_run.status in (
        'queued',
        'running'
      )

      and sync_run.next_attempt_at <= now()

      and (
        sync_run.lease_id is null
        or
        sync_run.lease_expires_at <= now()
      )

    order by
      sync_run.started_at asc

    for update skip locked

    limit 1
  )

  update public.sync_runs as sync_run

  set
    status = 'running',

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
on function public.claim_next_listings_sync_run(
  uuid,
  integer
)
from public;

revoke all
on function public.claim_next_listings_sync_run(
  uuid,
  integer
)
from anon;

revoke all
on function public.claim_next_listings_sync_run(
  uuid,
  integer
)
from authenticated;

grant execute
on function public.claim_next_listings_sync_run(
  uuid,
  integer
)
to service_role;


-- ------------------------------------------------------------
-- 4. FINALIZE FULL RECONCILIATION
-- ------------------------------------------------------------

create or replace function public.finalize_listings_sync_run(
  target_sync_run_id uuid,
  requested_lease_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_organization_id uuid;
  target_ml_account_id uuid;
begin
  select
    sync_run.organization_id,
    sync_run.ml_account_id

  into
    target_organization_id,
    target_ml_account_id

  from public.sync_runs as sync_run

  where sync_run.id =
    target_sync_run_id

    and sync_run.sync_type =
      'listings_full'

    and sync_run.status =
      'running'

    and sync_run.lease_id =
      requested_lease_id

  for update;

  if target_ml_account_id is null then
    return false;
  end if;


  -- Listings not seen during this complete run are no longer
  -- considered part of the current seller inventory.
  update public.ml_listings

  set is_current =
    (
      last_seen_sync_run_id =
        target_sync_run_id
    )

  where organization_id =
      target_organization_id

    and ml_account_id =
      target_ml_account_id;


  update public.ml_listing_variations

  set is_current =
    (
      last_seen_sync_run_id =
        target_sync_run_id
    )

  where organization_id =
      target_organization_id

    and ml_account_id =
      target_ml_account_id;


  update public.sync_runs

  set
    status = 'succeeded',

    lease_id = null,

    lease_expires_at = null,

    next_attempt_at = now(),

    finished_at = now()

  where id =
    target_sync_run_id;


  update public.ml_accounts

  set last_synced_at =
    now()

  where id =
      target_ml_account_id

    and organization_id =
      target_organization_id;


  return true;
end;
$$;


revoke all
on function public.finalize_listings_sync_run(
  uuid,
  uuid
)
from public;

revoke all
on function public.finalize_listings_sync_run(
  uuid,
  uuid
)
from anon;

revoke all
on function public.finalize_listings_sync_run(
  uuid,
  uuid
)
from authenticated;

grant execute
on function public.finalize_listings_sync_run(
  uuid,
  uuid
)
to service_role;