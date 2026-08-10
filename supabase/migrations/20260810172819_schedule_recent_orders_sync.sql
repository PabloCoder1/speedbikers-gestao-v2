-- ============================================================
-- Speed Bikers Gestão V2
-- Automatic recent Mercado Livre orders synchronization
-- ============================================================


create or replace function
private.dispatch_ml_sync_worker_task(
  worker_task text
)
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
        'Bearer ' ||
        worker_secret
      ),

    body :=
      jsonb_build_object(
        'source',
        'supabase_cron',

        'task',
        worker_task
      ),

    timeout_milliseconds :=
      60000
  )

  into request_id;


  return request_id;
end;
$$;


revoke all
on function
private.dispatch_ml_sync_worker_task(
  text
)
from public;

revoke all
on function
private.dispatch_ml_sync_worker_task(
  text
)
from anon;

revoke all
on function
private.dispatch_ml_sync_worker_task(
  text
)
from authenticated;

revoke all
on function
private.dispatch_ml_sync_worker_task(
  text
)
from service_role;


-- Avoid duplicate scheduler if migration is recreated.
select cron.unschedule(
  jobid
)
from cron.job
where jobname =
  'ml-orders-recent-every-5-minutes';


select cron.schedule(
  'ml-orders-recent-every-5-minutes',

  '*/5 * * * *',

  $$
    select
      private.dispatch_ml_sync_worker_task(
        'orders_recent'
      );
  $$
);