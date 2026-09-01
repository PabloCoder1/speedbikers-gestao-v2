-- ============================================================
-- Saude do Sistema (D-176, trilha 8A) — a metade que o BANCO pode responder.
--
-- O item pede detectar DRIFT entre o estado esperado e a infraestrutura
-- real, e o DoD e explicito: "nada deriva de documentacao" e "UNKNOWN se
-- medir falhar". Esta RPC entrega o que o banco sabe de si mesmo:
--
--   * qual migration esta APLICADA (versao, nome, quantas ao todo) — lida de
--     `supabase_migrations.schema_migrations`, que e schema privado e por
--     isso exige `security definer`;
--   * quando cada job rodou pela ultima vez, com que status, ha quantas
--     horas, e quantas falhas teve nas ultimas 24h — de `job_runs`, o
--     registro do que ACONTECEU, nao do que foi agendado.
--
-- O que ela NAO faz, de proposito: nao pergunta nada ao Google Cloud. O item
-- lista "permissoes cloud excessivas" como risco, e a alternativa honesta e
-- observar o EFEITO (o job rodou?) em vez do agendamento. Um scheduler
-- existente que nunca dispara e indistinguivel de um scheduler ausente para
-- quem depende do resultado — e `job_runs` mostra os dois casos igual.
--
-- `statements` e `rollback` da tabela de migrations NAO saem daqui: contem o
-- SQL inteiro, e a tela precisa da versao, nao do conteudo.
--
-- `security definer` com autorizacao REFEITA dentro: sem ADMIN, zero linhas.
-- Sem isso, `security definer` num schema privado seria um vazamento com
-- passo extra.
-- ============================================================

create function public.get_system_health()
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
  with guard as (
    -- A autorizacao e refeita aqui dentro, nunca herdada de quem chamou.
    select exists (
      select 1 from public.organization_members m
      where m.user_id = (select auth.uid()) and m.role = 'ADMIN'
    ) as ok
  ),
  migracao as (
    select sm.version, sm.name,
           -- A versao E o carimbo (YYYYMMDDHH24MISS): a tabela nao guarda
           -- data de aplicacao, entao a data sai do proprio nome.
           to_timestamp(sm.version, 'YYYYMMDDHH24MISS') at time zone 'UTC' as aplicada_em
    from supabase_migrations.schema_migrations sm
    order by sm.version desc
    limit 1
  ),
  total as (select count(*)::bigint as n from supabase_migrations.schema_migrations),
  ultimo_job as (
    select distinct on (r.job_type)
           r.job_type, r.status, coalesce(r.finished_at, r.started_at) as quando
    from public.job_runs r
    order by r.job_type, coalesce(r.finished_at, r.started_at) desc
  ),
  falhas as (
    select r.job_type, count(*)::bigint as n
    from public.job_runs r
    where r.status = 'failed' and r.started_at >= now() - interval '24 hours'
    group by r.job_type
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
  'Saude do Sistema (D-176): migration aplicada e ultima execucao de cada job, com idade e falhas em 24h. Le `supabase_migrations` (schema privado) via security definer, com autorizacao ADMIN refeita dentro. Nao consulta o Google Cloud de proposito: observa o EFEITO (job rodou) em vez do agendamento, evitando permissoes cloud novas.';

revoke all on function public.get_system_health() from public, anon;
grant execute on function public.get_system_health() to authenticated;
