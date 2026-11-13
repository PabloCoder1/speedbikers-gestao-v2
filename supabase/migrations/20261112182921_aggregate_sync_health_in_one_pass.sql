-- D-667. Uma agregação por conta, recurso e canal concentra os indicadores.
-- A busca pontual usa a chave de sync_runs_freshness_idx e desempata por ID.

create or replace function public.get_sync_health(p_organization_id uuid)
returns table (
  ml_account_id uuid,
  account_label text,
  resource text,
  channel text,
  last_run_at timestamptz,
  last_run_status text,
  last_run_reason text,
  last_success_at timestamptz,
  latest_record_at timestamptz,
  runs_24h bigint,
  failed_24h bigint,
  items_24h bigint
)
language sql stable security invoker set search_path = ''
as $$
with resumo as (
  select r.ml_account_id, r.resource, r.channel,
         max(r.finished_at) as last_run_at,
         max(r.finished_at) filter (where r.status in ('done', 'partial')) as last_success_at,
         max(r.latest_record_at) filter (where r.status in ('done', 'partial')) as latest_record_at,
         count(*) filter (where r.finished_at >= now() - interval '24 hours') as runs_24h,
         count(*) filter (
           where r.finished_at >= now() - interval '24 hours'
             and r.status not in ('done', 'partial')
         ) as failed_24h,
         coalesce(sum(r.items_processed) filter (where r.finished_at >= now() - interval '24 hours'), 0)::bigint as items_24h
  from public.sync_runs r
  where r.organization_id = p_organization_id
  group by r.ml_account_id, r.resource, r.channel
)
select s.ml_account_id, a.label, s.resource, s.channel,
       s.last_run_at, u.status, left(u.reason, 200),
       s.last_success_at, s.latest_record_at, s.runs_24h, s.failed_24h, s.items_24h
from resumo s
join public.ml_accounts a on a.id = s.ml_account_id
cross join lateral (
  select r.status, r.reason
  from public.sync_runs r
  where r.organization_id = p_organization_id
    and r.ml_account_id = s.ml_account_id
    and r.resource = s.resource
    and r.channel = s.channel
    and r.finished_at = s.last_run_at
  order by r.id desc
  limit 1
) u
order by a.label, s.resource, s.channel
$$;

comment on function public.get_sync_health(uuid) is
  'Saúde da sincronização por conta, recurso e canal. Agrega os indicadores sob RLS e resolve status e motivo da última execução em uma busca pontual (D-667).';
