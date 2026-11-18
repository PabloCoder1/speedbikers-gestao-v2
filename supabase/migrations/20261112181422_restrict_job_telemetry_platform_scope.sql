-- D-666. Jobs de uma organização removida permanecem no histórico.
-- A identificação de plataforma usa o heartbeat que apps/api/src/app.ts enfileira.

create function private.system_ping_organization_id()
returns uuid
language sql
immutable
parallel safe
set search_path = ''
as $$
  select '00000000-0000-4000-8000-000000000000'::uuid
$$;

revoke all on function private.system_ping_organization_id() from public, anon, authenticated;

create or replace function public.get_system_health()
returns table (
  db_migration_version text,
  db_migration_name text,
  db_migrations_count bigint,
  db_migration_applied_at timestamptz,
  job_type text,
  job_status text,
  job_last_run_at timestamptz,
  job_age_hours numeric,
  job_failures_24h bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive guard as (
    -- A autorizacao e refeita aqui dentro, nunca herdada de quem chamou.
    select exists (
      select 1 from public.organization_members m
      where m.user_id = (select auth.uid()) and m.role = 'ADMIN'
    ) as ok
  ),
  orgs_administradas as (
    -- Papel e organizacao na MESMA linha (D-180).
    select m.organization_id
    from public.organization_members m
    where m.user_id = (select auth.uid()) and m.role = 'ADMIN'
  ),
  visiveis as (
    select r.job_type, r.status, r.started_at, r.finished_at
    from public.job_runs r
    where r.organization_id in (select organization_id from orgs_administradas)
       or (r.job_type = 'system.ping' and r.organization_id = private.system_ping_organization_id())
  ),
  -- Skip scan: 22 tipos distintos em 335 mil linhas. Cada passo salta para o
  -- proximo `job_type` pelo indice, em vez de ler tudo e ordenar.
  tipos as (
    (select r.job_type from public.job_runs r order by r.job_type limit 1)
    union all
    select (select r.job_type from public.job_runs r
             where r.job_type > t.job_type
             order by r.job_type limit 1)
    from tipos t
    where t.job_type is not null
  ),
  migracao as (
    select sm.version, sm.name,
           to_timestamp(sm.version, 'YYYYMMDDHH24MISS') at time zone 'UTC' as aplicada_em
    from supabase_migrations.schema_migrations sm
    order by sm.version desc
    limit 1
  ),
  total as (select count(*)::bigint as n from supabase_migrations.schema_migrations),
  ultimo_job as (
    -- A VISIBILIDADE VIVE AQUI, no lateral, e nao na enumeracao acima: o
    -- lateral para na primeira linha VISIVEL de cada tipo. Um job_type que so
    -- exista em organizacao alheia nao produz linha e some do resultado --
    -- mesma saida do `distinct on` sobre `visiveis` que havia antes.
    select tp.job_type, u.status, u.quando
    from tipos tp
    cross join lateral (
      select r.status, coalesce(r.finished_at, r.started_at) as quando
      from public.job_runs r
      where r.job_type = tp.job_type
        and (r.organization_id in (select organization_id from orgs_administradas)
             or (r.job_type = 'system.ping' and r.organization_id = private.system_ping_organization_id()))
      order by coalesce(r.finished_at, r.started_at) desc
      limit 1
    ) u
    where tp.job_type is not null
  ),
  falhas as (
    -- Medida em 68 ms: fica como esta.
    select v.job_type, count(*)::bigint as n
    from visiveis v
    where v.status = 'failed' and v.started_at >= now() - interval '24 hours'
    group by v.job_type
  )
  select m.version, m.name, t.n, m.aplicada_em,
         j.job_type, j.status, j.quando,
         round(extract(epoch from (now() - j.quando)) / 3600, 1),
         coalesce(f.n, 0)
  from guard g
  cross join migracao m
  cross join total t
  left join ultimo_job j on true
  left join falhas f on f.job_type = j.job_type
  where g.ok
  order by j.job_type
$$;

comment on function public.get_system_health() is
  'Saúde do sistema por organização administrada, com heartbeat system.ping de plataforma e última execução por tipo via skip scan.';


create or replace function public.get_job_failures(
  p_days integer default 7,
  p_limit integer default 50
)
returns table (
  job_type text,
  reason_signature text,
  failures bigint,
  distinct_reasons bigint,
  retryable_failures bigint,
  first_failed_at timestamptz,
  last_failed_at timestamptz,
  sample_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  with guard as (
    -- A autorizacao e refeita aqui dentro, nunca herdada de quem chamou.
    select exists (
      select 1 from public.organization_members m
      where m.user_id = (select auth.uid()) and m.role = 'ADMIN'
    ) as ok
  ),
  orgs_administradas as (
    -- Papel e organizacao na MESMA linha (D-180).
    select m.organization_id
    from public.organization_members m
    where m.user_id = (select auth.uid()) and m.role = 'ADMIN'
  ),
  falhas as (
    select
      r.job_type,
      -- A assinatura: corridas de 4+ digitos viram `#`, entao o codigo HTTP
      -- (3 digitos) sobrevive e o id de dez nao. `reason` e NOT NULL quando
      -- `status = 'failed'`? Nao: o CHECK exige `retryable`, nao `reason` --
      -- por isso o coalesce, que nomeia a ausencia em vez de sumir com a linha.
      left(regexp_replace(coalesce(r.reason, '(sem motivo registrado)'), '[0-9]{4,}', '#', 'g'), 300)
        as assinatura,
      r.reason,
      r.retryable,
      r.finished_at
    from public.job_runs r
    where r.status = 'failed'
      -- Janela limitada no proprio SQL: `p_days` fora de 1..90 nao vira erro
      -- nem varredura da tabela inteira, vira o extremo mais proximo.
      and r.finished_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 90))
      and (
        r.organization_id in (select organization_id from orgs_administradas)
        or (r.job_type = 'system.ping' and r.organization_id = private.system_ping_organization_id())
      )
  )
  select
    f.job_type,
    f.assinatura,
    count(*)::bigint,
    count(distinct f.reason)::bigint,
    count(*) filter (where f.retryable)::bigint,
    min(f.finished_at),
    max(f.finished_at),
    -- Um exemplo CRU da familia, o mais recente: e ele que devolve o id que a
    -- assinatura apagou, e sem ele a linha nao daria para investigar.
    (array_agg(f.reason order by f.finished_at desc))[1]
  from guard g
  cross join falhas f
  where g.ok
  group by f.job_type, f.assinatura
  order by count(*) desc, max(f.finished_at) desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

comment on function public.get_job_failures(integer, integer) is
  'Falhas agregadas por tipo e assinatura para organizações administradas, com o heartbeat system.ping de plataforma.';
