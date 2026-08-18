-- ============================================================
-- Speed Bikers Gestao V2
--
-- ETAPA 32 — orders_v2 durable refresh queue.
--
-- Notifications on the orders_v2 topic enqueue a job here instead of
-- calling Mercado Livre from inside the webhook. A dedicated worker
-- claims jobs, fetches GET /orders/{id}, and persists the order via
-- the same logic the bulk sync already uses (persist_orders_batch).
-- ============================================================

create table public.ml_order_refresh_jobs (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null,
  ml_account_id uuid not null,

  order_id text not null,

  notification_key text not null,
  notification_id text,
  application_id text,
  seller_id text not null,
  resource text not null,

  status text not null default 'queued',

  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz not null default now(),

  lease_id uuid,
  lease_expires_at timestamptz,

  first_notified_at timestamptz not null default now(),
  last_notified_at timestamptz not null default now(),

  notification_revision bigint not null default 1,
  processed_revision bigint not null default 0,

  last_started_at timestamptz,
  processed_at timestamptz,

  error_code text,
  error_message text,

  raw_body text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ml_order_refresh_jobs_status_check
    check (status in ('queued', 'running', 'succeeded', 'failed', 'ignored')),

  constraint ml_order_refresh_jobs_attempt_count_check
    check (attempt_count >= 0),

  constraint ml_order_refresh_jobs_max_attempts_check
    check (max_attempts between 1 and 20),

  constraint ml_order_refresh_jobs_revision_check
    check (notification_revision >= 1 and processed_revision >= 0),

  constraint ml_order_refresh_jobs_lease_check
    check (
      (lease_id is null and lease_expires_at is null)
      or (lease_id is not null and lease_expires_at is not null)
    ),

  constraint ml_order_refresh_jobs_account_fk
    foreign key (organization_id, ml_account_id)
    references public.ml_accounts (organization_id, id)
    on delete cascade
);

-- Idempotency: a given notification (by its derived key) is only
-- ever enqueued once.
create unique index ml_order_refresh_jobs_notification_key_unique_idx
on public.ml_order_refresh_jobs (notification_key);

-- Never more than one active job per order: a fresh notification for
-- an order that already has a queued/running job must fold into it
-- (see enqueue_ml_order_refresh_notification below) instead of racing
-- a second worker against the same order.
create unique index ml_order_refresh_jobs_active_order_idx
on public.ml_order_refresh_jobs (ml_account_id, order_id)
where status in ('queued', 'running');

-- Same shape as every other job queue's claim index in this project
-- (operational_alert_jobs_queue_idx, ml_offer_refresh_jobs_queue_idx).
create index ml_order_refresh_jobs_queue_idx
on public.ml_order_refresh_jobs (status, next_attempt_at, created_at)
where status in ('queued', 'running');

create trigger ml_order_refresh_jobs_set_updated_at
before update on public.ml_order_refresh_jobs
for each row execute function private.set_updated_at();

alter table public.ml_order_refresh_jobs enable row level security;

revoke all on public.ml_order_refresh_jobs from anon;
revoke all on public.ml_order_refresh_jobs from authenticated;
grant all on public.ml_order_refresh_jobs to service_role;

comment on table public.ml_order_refresh_jobs is
'Durable asynchronous refresh jobs triggered by Mercado Livre orders_v2 notifications.';

-- ============================================================
-- Atomic job claim — identical lease pattern to
-- claim_next_operational_alert_job / claim_next_ml_offer_refresh_job.
-- ============================================================

create or replace function public.claim_next_ml_order_refresh_job(
  requested_lease_id uuid,
  lease_duration_seconds integer default 120
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare claimed_id uuid;
begin
  if requested_lease_id is null then
    raise exception 'lease_id_required';
  end if;

  if lease_duration_seconds < 30 or lease_duration_seconds > 300 then
    raise exception 'invalid_lease_duration';
  end if;

  with candidate as (
    select id from public.ml_order_refresh_jobs
    where status in ('queued', 'running') and next_attempt_at <= now()
      and (lease_id is null or lease_expires_at <= now())
    order by next_attempt_at, created_at
    for update skip locked
    limit 1
  )
  update public.ml_order_refresh_jobs as job
  set status = 'running',
      lease_id = requested_lease_id,
      lease_expires_at = now() + make_interval(secs => lease_duration_seconds),
      attempt_count = job.attempt_count + 1,
      last_started_at = now()
  from candidate
  where job.id = candidate.id
  returning job.id into claimed_id;

  return claimed_id;
end $$;

revoke all on function public.claim_next_ml_order_refresh_job(uuid, integer)
from public, anon, authenticated;
grant execute on function public.claim_next_ml_order_refresh_job(uuid, integer)
to service_role;

-- ============================================================
-- Atomic notification enqueue with active-job merge.
--
-- Resolves the account the same way enqueue_ml_offer_refresh_notification
-- does (seller_id + oauth_app_code against active ml_accounts).
--
-- A brand-new notification_key inserts normally. A second notification
-- for an order that already has an active job collides on the partial
-- unique index (ml_account_id, order_id) — not on notification_key —
-- so the insert's unique_violation is caught and folded into the
-- existing active row (bump notification_revision, refresh
-- last_notified_at, keep the latest notification_id/resource). This
-- is how process-order-refresh-job.ts learns to requeue instead of
-- losing an update that arrived mid-processing.
-- ============================================================

create or replace function public.enqueue_ml_order_refresh_notification(
  requested_app_code text,
  requested_seller_id text,
  requested_order_id text,
  requested_notification_key text,
  requested_notification_id text,
  requested_resource text,
  requested_application_id text,
  requested_raw_body text
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  target_organization_id uuid;
  target_ml_account_id uuid;
  inserted_job_id uuid;
  merged_job_id uuid;
begin
  select account.organization_id, account.id
  into target_organization_id, target_ml_account_id
  from public.ml_accounts as account
  where account.seller_id = requested_seller_id
    and account.oauth_app_code = requested_app_code
    and account.is_active = true
    and account.connection_status = 'connected'
  order by account.created_at asc
  limit 1;

  if target_ml_account_id is null then
    return 'unknown_account';
  end if;

  begin
    insert into public.ml_order_refresh_jobs (
      organization_id, ml_account_id, order_id, notification_key,
      notification_id, application_id, seller_id, resource, raw_body
    ) values (
      target_organization_id, target_ml_account_id, requested_order_id,
      requested_notification_key, requested_notification_id,
      requested_application_id, requested_seller_id, requested_resource,
      requested_raw_body
    )
    on conflict (notification_key) do nothing
    returning id into inserted_job_id;
  exception when unique_violation then
    -- Hit ml_order_refresh_jobs_active_order_idx: an active job for
    -- this order already exists. Fold this notification into it.
    inserted_job_id := null;
  end;

  if inserted_job_id is not null then
    return 'queued';
  end if;

  update public.ml_order_refresh_jobs
  set last_notified_at = now(),
      notification_revision = notification_revision + 1,
      notification_id = coalesce(requested_notification_id, notification_id),
      resource = requested_resource
  where ml_account_id = target_ml_account_id
    and order_id = requested_order_id
    and status in ('queued', 'running')
  returning id into merged_job_id;

  if merged_job_id is not null then
    return 'queued';
  end if;

  -- No active job to merge into either: a true duplicate notification_key.
  return 'duplicate';
end $$;

revoke all on function public.enqueue_ml_order_refresh_notification(
  text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.enqueue_ml_order_refresh_notification(
  text, text, text, text, text, text, text, text
) to service_role;
