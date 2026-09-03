-- ============================================================
-- `get_system_health`: a ultima execucao por job deixa de varrer a tabela.
--
-- ESTA FATIA NASCEU DE UM ITEM QUE A MEDICAO REFUTOU. O item registrado era
-- "retencao de job_runs (271.184 linhas), destravada pelo deploy" -- a ideia
-- sendo que a tabela e grande demais. Medindo antes de agir, contra o Dev
-- real (335.835 linhas hoje):
--
--   * a tabela ocupa 112 MB, 15,6% do banco -- isso e verdade e continua;
--   * MAS o custo que fazia alguem olhar para ela nao e volume, e CONSULTA.
--
-- O `distinct on (job_type)` desta funcao custava **1.134 ms** varrendo as
-- 335 mil linhas e derramando **16,5 MB para disco** (`Sort Method: external
-- merge`) -- para devolver **22 linhas**, uma por tipo de job.
--
-- DUAS HIPOTESES TESTADAS ANTES DA ESCOLHIDA, as duas em transacao revertida
-- contra o Dev:
--
--   1. So um indice em (job_type, quando desc): **PIOROU** -- 5.985 ms contra
--      1.134 ms, tocando 260.656 buffers contra 9.625. O `distinct on`
--      percorre o indice INTEIRO; o Postgres nao faz skip scan sozinho aqui,
--      e trocar seq scan + sort por index scan aleatorio saiu caro.
--   2. Skip scan emulado por CTE recursiva + o mesmo indice: **0,462 ms**,
--      174 buffers. E a forma que aproveita o fato decisivo -- ha 335 mil
--      linhas e apenas **22 tipos distintos**.
--
-- 1.134 ms -> 0,462 ms, **2.450x**, sem apagar uma linha.
--
-- O ESCOPO DE D-209 CONTINUA INTEIRO, e e a parte delicada da reescrita. A
-- visibilidade nao pode migrar para a enumeracao dos tipos: ela vive DENTRO
-- do lateral, que para na primeira linha visivel de cada tipo. Um `job_type`
-- que so exista em organizacao alheia nao produz linha nenhuma e some do
-- resultado -- exatamente como o `distinct on` sobre `visiveis` fazia. Ha
-- teste entrando pela segunda organizacao para fixar isso.
--
-- A enumeracao dos tipos NAO e escopada, de proposito: escopa-la exigiria o
-- indice comecando por organizacao e destruiria o skip scan. O nome do tipo
-- nunca chega a saida -- o lateral e INNER, entao o tipo invisivel e
-- descartado antes de qualquer projecao.
--
-- `falhas` fica como esta: medida em **68 ms**, dentro do orcamento. Otimizar
-- o que nao dói e o oposto do que esta trilha faz.
--
-- O QUE ESTA FATIA NAO RESOLVE, e fica dito: os 112 MB. A retencao continua
-- aberta e agora e uma questao de DISCO, nao de tempo de resposta -- com uma
-- barreira que o item nao mencionava e que quem for fazer precisa saber:
-- **`job_runs` recusa DELETE por trigger** (`job_runs_no_delete`,
-- 20260820160000), inclusive para `service_role`. Expurgo exige um caminho
-- explicito, nao um `delete`.
-- ============================================================

-- O indice serve as duas pontas do skip scan: a enumeracao (`job_type >`) e a
-- busca da ultima execucao dentro do tipo. `coalesce` na expressao porque e
-- assim que a funcao ordena -- indice em `finished_at` puro nao serviria.
create index if not exists job_runs_last_per_type_idx
  on public.job_runs (job_type, (coalesce(finished_at, started_at)) desc);

comment on index public.job_runs_last_per_type_idx is
  'Sustenta o skip scan de get_system_health: 335 mil linhas, 22 tipos distintos. Sozinho ele PIORA um distinct on (5.985 ms contra 1.134); e a CTE recursiva que o transforma em 0,462 ms.';

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
       or not exists (
         select 1 from public.organizations o where o.id = r.organization_id
       )
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
             or not exists (
               select 1 from public.organizations o where o.id = r.organization_id
             ))
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
  'Saude do Sistema (D-176): migration aplicada e ultima execucao de cada job, com idade e falhas em 24h. Le `supabase_migrations` via security definer, com autorizacao ADMIN refeita dentro. `job_runs` e escopado as organizacoes onde o chamador e ADMIN, mais os jobs de PLATAFORMA (organizacao inexistente no catalogo), que e o que impede o escopo de apagar o heartbeat (D-209). A ultima execucao por tipo usa SKIP SCAN (CTE recursiva + job_runs_last_per_type_idx): 22 tipos distintos em 335 mil linhas, 1.134 ms -> 0,462 ms. A visibilidade vive no lateral, nao na enumeracao dos tipos.';
