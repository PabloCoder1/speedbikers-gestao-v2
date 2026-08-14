-- ============================================================
-- Speed Bikers Gestao V2
--
-- Final Mercado Livre offer price background pipeline.
-- ============================================================


-- ============================================================
-- 1. CONCURRENT-SAFE SNAPSHOTS
-- ============================================================

create unique index
ml_offer_price_state_snapshots_listing_hash_unique_idx

on public.ml_offer_price_state_snapshots (
  ml_listing_id,
  state_hash
);


-- ============================================================
-- 2. ASYNC OFFER REFRESH JOBS
-- ============================================================

create table
public.ml_offer_refresh_jobs (
  id uuid primary key
    default gen_random_uuid(),

  organization_id uuid not null,
  ml_account_id uuid not null,
  ml_listing_id uuid,

  item_id text,
  offer_id text,

  reason text not null,
  topic text,

  notification_key text,
  notification_id text,
  resource text,
  seller_id text,
  application_id text,
  notification_attempts integer,
  notification_sent_at timestamptz,
  notification_received_at timestamptz,
  raw_body text,

  status text not null
    default 'queued',

  attempt_count integer not null
    default 0,

  max_attempts integer not null
    default 5,

  next_attempt_at timestamptz not null
    default now(),

  lease_id uuid,
  lease_expires_at timestamptz,

  error_code text,
  error_message text,

  created_at timestamptz not null
    default now(),

  updated_at timestamptz not null
    default now(),

  processed_at timestamptz,

  constraint ml_offer_refresh_jobs_target_check
    check (
      item_id is not null
      or offer_id is not null
    ),

  constraint ml_offer_refresh_jobs_reason_check
    check (
      reason in (
        'items_prices',
        'public_offers',
        'manual'
      )
    ),

  constraint ml_offer_refresh_jobs_status_check
    check (
      status in (
        'queued',
        'running',
        'succeeded',
        'failed',
        'ignored'
      )
    ),

  constraint ml_offer_refresh_jobs_attempt_count_check
    check (
      attempt_count >= 0
    ),

  constraint ml_offer_refresh_jobs_max_attempts_check
    check (
      max_attempts between 1 and 20
    ),

  constraint ml_offer_refresh_jobs_lease_check
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
    ),

  constraint ml_offer_refresh_jobs_account_fk
    foreign key (
      organization_id,
      ml_account_id
    )
    references public.ml_accounts (
      organization_id,
      id
    )
    on delete cascade,

  constraint ml_offer_refresh_jobs_listing_fk
    foreign key (
      organization_id,
      ml_account_id,
      ml_listing_id
    )
    references public.ml_listings (
      organization_id,
      ml_account_id,
      id
    )
    on delete cascade
);


create unique index
ml_offer_refresh_jobs_notification_key_unique_idx

on public.ml_offer_refresh_jobs (
  notification_key
);


create index
ml_offer_refresh_jobs_queue_idx

on public.ml_offer_refresh_jobs (
  status,
  next_attempt_at,
  created_at
)

where
  status in (
    'queued',
    'running'
  );


create index
ml_offer_refresh_jobs_account_item_idx

on public.ml_offer_refresh_jobs (
  ml_account_id,
  item_id,
  created_at desc
);


create index
ml_offer_refresh_jobs_offer_idx

on public.ml_offer_refresh_jobs (
  offer_id
)

where
  offer_id is not null;


create trigger
ml_offer_refresh_jobs_set_updated_at

before update
on public.ml_offer_refresh_jobs

for each row
execute function private.set_updated_at();


alter table
public.ml_offer_refresh_jobs
enable row level security;


revoke all
on public.ml_offer_refresh_jobs
from anon;


revoke all
on public.ml_offer_refresh_jobs
from authenticated;


grant all
on public.ml_offer_refresh_jobs
to service_role;


comment on table
public.ml_offer_refresh_jobs
is
'Durable asynchronous refresh jobs triggered by Mercado Livre price and public offer notifications.';


-- ============================================================
-- 3. STATE PROVENANCE
-- ============================================================

alter table
public.ml_offer_price_states

add column
refresh_source text not null
default 'unknown',

add column
source_refresh_job_id uuid,

add column
last_notification_topic text,

add constraint
ml_offer_price_states_refresh_source_check
check (
  refresh_source in (
    'unknown',
    'debug',
    'backfill',
    'notification',
    'reconcile',
    'manual'
  )
),

add constraint
ml_offer_price_states_refresh_job_fk
foreign key (
  source_refresh_job_id
)
references public.ml_offer_refresh_jobs (
  id
)
on delete set null;


alter table
public.ml_offer_price_state_snapshots

add column
refresh_source text not null
default 'unknown',

add column
source_refresh_job_id uuid,

add constraint
ml_offer_price_state_snapshots_refresh_source_check
check (
  refresh_source in (
    'unknown',
    'debug',
    'backfill',
    'notification',
    'reconcile',
    'manual'
  )
),

add constraint
ml_offer_price_state_snapshots_refresh_job_fk
foreign key (
  source_refresh_job_id
)
references public.ml_offer_refresh_jobs (
  id
)
on delete set null;


-- ============================================================
-- 4. ATOMIC REFRESH JOB CLAIM
-- ============================================================

create or replace function
public.claim_next_ml_offer_refresh_job(
  requested_lease_id uuid,
  lease_duration_seconds integer
    default 120
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_job_id uuid;
begin
  if requested_lease_id is null then
    raise exception
      'lease_id_required';
  end if;

  if (
    lease_duration_seconds < 30
    or lease_duration_seconds > 300
  ) then
    raise exception
      'invalid_lease_duration';
  end if;

  with candidate as (
    select
      refresh_job.id

    from
      public.ml_offer_refresh_jobs
        as refresh_job

    where
      refresh_job.status in (
        'queued',
        'running'
      )

      and refresh_job.next_attempt_at <=
        now()

      and (
        refresh_job.lease_id is null
        or refresh_job.lease_expires_at <= now()
      )

    order by
      refresh_job.next_attempt_at asc,
      refresh_job.created_at asc

    for update
      skip locked

    limit 1
  )

  update
    public.ml_offer_refresh_jobs
      as refresh_job

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
        ),

    attempt_count =
      refresh_job.attempt_count + 1

  from
    candidate

  where
    refresh_job.id =
      candidate.id

  returning
    refresh_job.id

  into
    claimed_job_id;

  return
    claimed_job_id;
end;
$$;


revoke all
on function
public.claim_next_ml_offer_refresh_job(
  uuid,
  integer
)
from public;

revoke all
on function
public.claim_next_ml_offer_refresh_job(
  uuid,
  integer
)
from anon;

revoke all
on function
public.claim_next_ml_offer_refresh_job(
  uuid,
  integer
)
from authenticated;

grant execute
on function
public.claim_next_ml_offer_refresh_job(
  uuid,
  integer
)
to service_role;


-- ============================================================
-- 5. ATOMIC NOTIFICATION ENQUEUE
-- ============================================================

create or replace function
public.enqueue_ml_offer_refresh_notification(
  requested_app_code text,
  requested_seller_id text,
  requested_topic text,
  requested_resource text,
  requested_item_id text,
  requested_offer_id text,
  requested_notification_key text,
  requested_notification_id text,
  requested_application_id text,
  requested_notification_attempts integer,
  requested_sent_at timestamptz,
  requested_received_at timestamptz,
  requested_raw_body text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_organization_id uuid;
  target_ml_account_id uuid;
  inserted_job_id uuid;
  target_reason text;
begin
  target_reason :=
    case requested_topic
      when 'items_prices' then
        'items_prices'
      when 'public_offers' then
        'public_offers'
      else
        null
    end;

  if target_reason is null then
    raise exception
      'unsupported_notification_topic';
  end if;

  select
    account.organization_id,
    account.id

  into
    target_organization_id,
    target_ml_account_id

  from
    public.ml_accounts
      as account

  where
    account.seller_id =
      requested_seller_id

    and account.oauth_app_code =
      requested_app_code

    and account.is_active =
      true

    and account.connection_status =
      'connected'

  order by
    account.created_at asc

  limit 1;

  if target_ml_account_id is null then
    return
      'unknown_account';
  end if;

  insert into
    public.ml_offer_refresh_jobs (
      organization_id,
      ml_account_id,
      item_id,
      offer_id,
      reason,
      topic,
      notification_key,
      notification_id,
      resource,
      seller_id,
      application_id,
      notification_attempts,
      notification_sent_at,
      notification_received_at,
      raw_body
    )

  values (
    target_organization_id,
    target_ml_account_id,
    requested_item_id,
    requested_offer_id,
    target_reason,
    requested_topic,
    requested_notification_key,
    requested_notification_id,
    requested_resource,
    requested_seller_id,
    requested_application_id,
    requested_notification_attempts,
    requested_sent_at,
    coalesce(
      requested_received_at,
      now()
    ),
    requested_raw_body
  )

  on conflict (
    notification_key
  )
  do nothing

  returning
    id

  into
    inserted_job_id;

  if inserted_job_id is null then
    return
      'duplicate';
  end if;

  return
    'queued';
end;
$$;


revoke all
on function
public.enqueue_ml_offer_refresh_notification(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  integer,
  timestamptz,
  timestamptz,
  text
)
from public;

revoke all
on function
public.enqueue_ml_offer_refresh_notification(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  integer,
  timestamptz,
  timestamptz,
  text
)
from anon;

revoke all
on function
public.enqueue_ml_offer_refresh_notification(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  integer,
  timestamptz,
  timestamptz,
  text
)
from authenticated;

grant execute
on function
public.enqueue_ml_offer_refresh_notification(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  integer,
  timestamptz,
  timestamptz,
  text
)
to service_role;


-- ============================================================
-- 6. EXISTING AND FUTURE BACKFILL THROUGHPUT
-- ============================================================

update
  public.sync_runs

set
  batch_size =
    8

where
  sync_type =
    'offer_prices_backfill'

  and status in (
    'queued',
    'running'
  )

  and batch_size <
    8;


-- ============================================================
-- 7. DEDICATED DUE-WORK DISPATCHERS
-- ============================================================

create or replace function
private.dispatch_due_offer_prices_workers()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  due_count integer;
  dispatch_count integer;
  current_dispatch integer;
begin
  select
    least(
      count(*)::integer,
      4
    )

  into
    due_count

  from
    public.sync_runs
      as sync_run

  where
    sync_run.sync_type =
      'offer_prices_backfill'

    and sync_run.status in (
      'queued',
      'running'
    )

    and sync_run.next_attempt_at <=
      now()

    and (
      sync_run.lease_id is null
      or sync_run.lease_expires_at <= now()
    );

  dispatch_count :=
    coalesce(
      due_count,
      0
    );

  for current_dispatch in
    1..dispatch_count
  loop
    perform
      private.dispatch_ml_sync_worker_task(
        'offer_prices_backfill'
      );
  end loop;

  return
    dispatch_count;
end;
$$;


create or replace function
private.dispatch_due_offer_refresh_workers()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  due_count integer;
  dispatch_count integer;
  current_dispatch integer;
begin
  select
    least(
      count(*)::integer,
      4
    )

  into
    due_count

  from
    public.ml_offer_refresh_jobs
      as refresh_job

  where
    refresh_job.status in (
      'queued',
      'running'
    )

    and refresh_job.next_attempt_at <=
      now()

    and (
      refresh_job.lease_id is null
      or refresh_job.lease_expires_at <= now()
    );

  dispatch_count :=
    coalesce(
      due_count,
      0
    );

  for current_dispatch in
    1..dispatch_count
  loop
    perform
      private.dispatch_ml_sync_worker_task(
        'offer_refresh'
      );
  end loop;

  return
    dispatch_count;
end;
$$;


revoke all
on function
private.dispatch_due_offer_prices_workers()
from public;

revoke all
on function
private.dispatch_due_offer_prices_workers()
from anon;

revoke all
on function
private.dispatch_due_offer_prices_workers()
from authenticated;

revoke all
on function
private.dispatch_due_offer_prices_workers()
from service_role;

revoke all
on function
private.dispatch_due_offer_refresh_workers()
from public;

revoke all
on function
private.dispatch_due_offer_refresh_workers()
from anon;

revoke all
on function
private.dispatch_due_offer_refresh_workers()
from authenticated;

revoke all
on function
private.dispatch_due_offer_refresh_workers()
from service_role;


-- ============================================================
-- 8. DAILY RECONCILIATION
-- ============================================================

create or replace function
private.enqueue_offer_prices_reconciliation()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  account record;
  current_listing_count integer;
  inserted_count integer := 0;
begin
  for account in
    select
      ml_account.organization_id,
      ml_account.id

    from
      public.ml_accounts
        as ml_account

    where
      ml_account.is_active =
        true

      and ml_account.connection_status =
        'connected'
  loop
    select
      count(*)::integer

    into
      current_listing_count

    from
      public.ml_listings
        as listing

    where
      listing.organization_id =
        account.organization_id

      and listing.ml_account_id =
        account.id

      and listing.is_current =
        true;

    if current_listing_count > 0 then
      insert into
        public.sync_runs (
          organization_id,
          ml_account_id,
          sync_type,
          status,
          cursor_offset,
          batch_size,
          records_discovered,
          records_processed,
          records_upserted,
          retry_count,
          max_retries,
          requested_by,
          metadata
        )

      values (
        account.organization_id,
        account.id,
        'offer_prices_backfill',
        'queued',
        0,
        8,
        current_listing_count,
        0,
        0,
        0,
        3,
        null,
        jsonb_build_object(
          'mode',
          'reconcile',
          'cursor_listing_id',
          null,
          'initial_current_listings',
          current_listing_count,
          'failure_count',
          0,
          'failed_items',
          jsonb_build_array(),
          'snapshots_inserted_total',
          0,
          'enqueued_at',
          to_jsonb(now()),
          'reconciliation_reason',
          'daily'
        )
      )

      on conflict
      do nothing;

      if found then
        inserted_count :=
          inserted_count + 1;
      end if;
    end if;
  end loop;

  return
    inserted_count;
end;
$$;


revoke all
on function
private.enqueue_offer_prices_reconciliation()
from public;

revoke all
on function
private.enqueue_offer_prices_reconciliation()
from anon;

revoke all
on function
private.enqueue_offer_prices_reconciliation()
from authenticated;

revoke all
on function
private.enqueue_offer_prices_reconciliation()
from service_role;


-- ============================================================
-- 9. CRON SCHEDULES
-- ============================================================

select
  cron.unschedule(
    jobid
  )

from
  cron.job

where
  jobname =
    'ml-offer-prices-workers-every-minute';


select
  cron.schedule(
    'ml-offer-prices-workers-every-minute',
    '* * * * *',
    $$
      select
        private.dispatch_due_offer_prices_workers();
    $$
  );


select
  cron.unschedule(
    jobid
  )

from
  cron.job

where
  jobname =
    'ml-offer-refresh-workers-every-minute';


select
  cron.schedule(
    'ml-offer-refresh-workers-every-minute',
    '* * * * *',
    $$
      select
        private.dispatch_due_offer_refresh_workers();
    $$
  );


select
  cron.unschedule(
    jobid
  )

from
  cron.job

where
  jobname =
    'ml-offer-prices-reconcile-daily';


select
  cron.schedule(
    'ml-offer-prices-reconcile-daily',
    '17 7 * * *',
    $$
      select
        private.enqueue_offer_prices_reconciliation();
    $$
  );
