-- ETAPA 36: Diagnostico executivo + inteligencia competitiva (V2).
--
-- V1 (product_diagnostic_runs, prompt product-diagnostic-v1) is untouched —
-- old rows keep their shape forever. V2 runs land in the same table with
-- prompt_version='product-diagnostic-v2' and a different result shape; the
-- app branches on prompt_version when rendering.
--
-- Adds two new tables:
--   product_market_research_runs — a simple fetched_at/expires_at cache
--     (no snapshot/history table: official ML competitive data and web
--     research are fetched on-demand for one product at a time, not synced
--     in bulk, so the two-table current+snapshot shape used by
--     ml_offer_price_states doesn't apply here).
--   product_diagnostic_jobs — the async job queue. Mirrors the current,
--     most-hardened job-table shape in this codebase
--     (product_inventory_reconcile_jobs: 20260819... — active-job unique
--     index, attempt_count < max_attempts baked into the claim WHERE
--     clause, auth.role() = 'service_role' guard) rather than the older
--     operational_alert_jobs shape, which lacks that guard and needs a
--     separate dead-letter sweep.

create table public.product_market_research_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  kind text not null check (kind in ('official_ml', 'external_web')),
  status text not null check (status in ('succeeded', 'failed')),
  data jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index product_market_research_runs_lookup_idx
  on public.product_market_research_runs (organization_id, product_id, kind, expires_at desc);

alter table public.product_market_research_runs enable row level security;

create policy product_market_research_runs_select_members
  on public.product_market_research_runs
  for select
  to authenticated
  using (private.is_organization_member(organization_id));

create table public.product_diagnostic_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  product_id uuid not null,
  requested_by uuid not null references auth.users(id),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  phase text not null default 'evidence' check (phase in ('evidence', 'market_official', 'market_external', 'vision', 'claude', 'persist')),
  force boolean not null default false,
  diagnostic_run_id uuid references public.product_diagnostic_runs(id) on delete set null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((lease_id is null and lease_expires_at is null) or (lease_id is not null and lease_expires_at is not null)),
  foreign key (organization_id, product_id) references public.products(organization_id, id) on delete cascade
);

create unique index product_diagnostic_jobs_active_idx
  on public.product_diagnostic_jobs (organization_id, product_id)
  where status in ('queued', 'running');

create index product_diagnostic_jobs_queue_idx
  on public.product_diagnostic_jobs (status, next_attempt_at, created_at, id)
  where status in ('queued', 'running');

create index product_diagnostic_jobs_product_idx
  on public.product_diagnostic_jobs (organization_id, product_id, status);

alter table public.product_diagnostic_jobs enable row level security;

create policy product_diagnostic_jobs_select_members
  on public.product_diagnostic_jobs
  for select
  to authenticated
  using (private.is_organization_member(organization_id));

-- Claims exactly one job per call — the worker route calls this once per
-- invocation (no burst loop), and pg_cron dispatches at most one worker
-- invocation per minute for this task (see dispatch function below), per
-- the spec's "uma analise por worker por padrao, nao disparar concorrencia
-- alta". attempt_count < max_attempts in the WHERE clause means an
-- exhausted job simply stops being claimable; the sweep below fails it
-- explicitly instead of leaving it stuck 'running' forever blocking the
-- active-job unique index for that product.
create or replace function public.claim_next_product_diagnostic_job(requested_lease_id uuid, lease_duration_seconds integer default 120)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  claimed_id uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'not_authorized';
  end if;
  if requested_lease_id is null then
    raise exception 'lease_id_required';
  end if;

  update public.product_diagnostic_jobs
  set status = 'failed', lease_id = null, lease_expires_at = null,
      error_code = coalesce(error_code, 'lease_reclaim_exhausted'),
      error_message = coalesce(error_message, 'O worker nao concluiu o job dentro do numero maximo de tentativas.'),
      completed_at = now()
  where status in ('queued', 'running')
    and attempt_count >= max_attempts
    and lease_id is not null
    and lease_expires_at <= now();

  with candidate as (
    select job.id
    from public.product_diagnostic_jobs as job
    where job.status in ('queued', 'running')
      and job.attempt_count < job.max_attempts
      and job.next_attempt_at <= now()
      and (job.lease_id is null or job.lease_expires_at <= now())
    order by job.next_attempt_at, job.created_at, job.id
    for update skip locked
    limit 1
  )
  update public.product_diagnostic_jobs as job
  set status = 'running',
      lease_id = requested_lease_id,
      lease_expires_at = now() + make_interval(secs => greatest(30, least(lease_duration_seconds, 600))),
      attempt_count = job.attempt_count + 1
  from candidate
  where job.id = candidate.id
  returning job.id into claimed_id;

  return claimed_id;
end;
$function$;

grant execute on function public.claim_next_product_diagnostic_job(uuid, integer) to service_role;

-- Same "at most 1 worker invocation per minute" shape as the
-- reduce_alert_dispatch_concurrency hotfix (20260818162000), applied from
-- the start here instead of needing a follow-up fix.
create or replace function private.dispatch_due_product_diagnostic_workers()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  due_count integer;
  current_dispatch integer;
begin
  select least(count(*)::integer, 1)
  into due_count
  from public.product_diagnostic_jobs
  where status in ('queued', 'running')
    and attempt_count < max_attempts
    and next_attempt_at <= now()
    and (lease_id is null or lease_expires_at <= now());

  for current_dispatch in 1..coalesce(due_count, 0) loop
    perform private.dispatch_ml_sync_worker_task('product_diagnostic');
  end loop;

  return coalesce(due_count, 0);
end;
$function$;

select cron.schedule(
  'product-diagnostic-workers-every-minute',
  '* * * * *',
  $$select private.dispatch_due_product_diagnostic_workers();$$
);

-- Lets the enqueue API route trigger the worker immediately after inserting
-- a job, instead of waiting up to 60s for the next cron tick. The
-- per-minute cron above remains as the fallback if this direct dispatch
-- fails or is skipped. service_role already has full DB access, so this
-- grants no new capability — it only lets it call a function that was
-- previously only reachable from other security-definer functions.
grant execute on function private.dispatch_ml_sync_worker_task(text) to service_role;
