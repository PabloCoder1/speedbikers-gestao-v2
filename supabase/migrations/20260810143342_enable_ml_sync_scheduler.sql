-- ============================================================
-- Speed Bikers Gestão V2
-- Automatic Mercado Livre synchronization scheduler
-- ============================================================


-- ------------------------------------------------------------
-- 1. REQUIRED EXTENSIONS
-- ------------------------------------------------------------

-- Async HTTP requests from Postgres.
create extension if not exists pg_net
with schema extensions;

-- Recurring jobs.
create extension if not exists pg_cron;


-- ------------------------------------------------------------
-- 2. PRIVATE WORKER DISPATCHER
--
-- The worker URL and secret are read from Supabase Vault.
-- No secret is persisted inside the migration or cron command.
-- ------------------------------------------------------------

create or replace function private.dispatch_ml_sync_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  worker_url text;
  worker_secret text;
  request_id bigint;
begin

  select decrypted_secret
  into worker_url
  from vault.decrypted_secrets
  where name =
    'ml_sync_worker_url'
  limit 1;


  select decrypted_secret
  into worker_secret
  from vault.decrypted_secrets
  where name =
    'ml_sync_worker_secret'
  limit 1;


  if (
    worker_url is null
    or btrim(worker_url) = ''
  ) then
    raise exception
      'ml_sync_worker_url_not_configured';
  end if;


  if (
    worker_secret is null
    or btrim(worker_secret) = ''
  ) then
    raise exception
      'ml_sync_worker_secret_not_configured';
  end if;


  select net.http_post(
    url :=
      worker_url,

    headers :=
      jsonb_build_object(
        'Content-Type',
        'application/json',

        'Authorization',
        'Bearer ' || worker_secret
      ),

    body :=
      jsonb_build_object(
        'source',
        'supabase_cron'
      ),

    timeout_milliseconds :=
      60000
  )
  into request_id;


  return request_id;
end;
$$;


-- ------------------------------------------------------------
-- 3. SECURITY
-- ------------------------------------------------------------

revoke all
on function private.dispatch_ml_sync_worker()
from public;

revoke all
on function private.dispatch_ml_sync_worker()
from anon;

revoke all
on function private.dispatch_ml_sync_worker()
from authenticated;

revoke all
on function private.dispatch_ml_sync_worker()
from service_role;


-- ------------------------------------------------------------
-- 4. CRON
--
-- One invocation per minute.
-- The database lease implemented in ETAPA 24A prevents two
-- workers from processing the same sync run simultaneously.
-- ------------------------------------------------------------

select cron.schedule(
  'ml-sync-worker-every-minute',
  '* * * * *',
  $$
    select private.dispatch_ml_sync_worker();
  $$
);