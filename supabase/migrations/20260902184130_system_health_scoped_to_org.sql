-- ============================================================
-- `get_system_health` ganha escopo de organizacao (item 7 do HANDOFF, aberto
-- por D-182).
--
-- O DEFEITO, e ele e latente, nao ativo: a funcao devolve telemetria de
-- PLATAFORMA (`job_runs` de TODAS as organizacoes) protegida por um papel de
-- escopo de TENANT — o guard pergunta "e ADMIN de alguma organizacao?", nunca
-- "de qual". Com uma organizacao ela esta correta por acidente. Com duas, o
-- ADMIN de B passa a ver quais jobs a organizacao A roda, quando rodaram pela
-- ultima vez e quantas vezes falharam em 24h.
--
-- AS DUAS CORRECOES OBVIAS CONTINUAM RECUSADAS, pelas razoes que D-182 mediu:
--
--   1. filtrar `job_runs` pela organizacao do chamador APAGA O HEARTBEAT.
--      `system.ping` e enfileirado com a organizacao SENTINELA
--      `00000000-0000-4000-8000-000000000000` (`apps/api/src/app.ts`), que nao
--      e organizacao de ninguem. Ele e a razao de ser da tela: e o unico sinal
--      que prova que `api -> Cloud Tasks -> worker` esta inteiro;
--   2. mudar a assinatura quebra `apps/web/app/saude/page.tsx` e os tipos
--      gerados.
--
-- A TERCEIRA SAIDA, que e esta: a linha de `job_runs` aparece quando pertence
-- a uma organizacao onde o chamador e ADMIN **ou** quando nao pertence a
-- organizacao nenhuma.
--
-- "Nao pertence a organizacao nenhuma" e derivado do CATALOGO (`not exists`
-- contra `organizations`), NAO do UUID sentinela copiado para ca. O sentinela
-- ja tem uma definicao, em `apps/api/src/app.ts`; copia-lo criaria a segunda,
-- que e exatamente como "Full atual" acabou com tres definicoes divergentes
-- (D-204). Derivar do catalogo tambem cobre qualquer job de plataforma futuro
-- sem editar esta funcao.
--
-- O QUE CONTINUA COM ESCOPO DE PLATAFORMA, DE PROPOSITO: a versao da migration
-- aplicada, o nome e a contagem. Nao sao dado de tenant — sao um unico valor
-- para o banco inteiro, e sao a pergunta que a tela existe para responder ("o
-- schema aplicado e o que eu acho que esta aplicado?"). Escopa-las por
-- organizacao nao protegeria ninguem e esvaziaria a tela.
--
-- A ASSINATURA NAO MUDA: as mesmas 9 colunas, na mesma ordem, com os mesmos
-- tipos. `apps/web/app/saude/page.tsx` e `packages/db/src/types.ts` seguem
-- valendo sem uma linha de alteracao — que era a segunda restricao de D-182.
--
-- POR QUE O CONJUNTO, E NAO `private.has_org_role(...)` POR LINHA: o helper
-- canonico de D-180 e escalar, e receberia uma COLUNA como argumento — viraria
-- uma chamada por linha varrida de `job_runs`, que tem 271 mil linhas. E a
-- forma exata que D-181 mediu em 9.104 ms e a que D-182 registrou em 13-19 us
-- por linha. Aqui o conjunto e obrigatorio; nas 21 policies nao era, porque as
-- tabelas eram pequenas.
-- ============================================================

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
  with guard as (
    -- A autorizacao e refeita aqui dentro, nunca herdada de quem chamou.
    -- Continua sendo "e ADMIN em algum lugar": e o que decide se a tela ABRE.
    select exists (
      select 1 from public.organization_members m
      where m.user_id = (select auth.uid()) and m.role = 'ADMIN'
    ) as ok
  ),
  -- E este conjunto — e nao o guard acima — que decide QUAIS linhas de
  -- `job_runs` sao do chamador. Papel e organizacao na MESMA linha, a licao
  -- de D-180: ser ADMIN em A nao pode valer como ADMIN em B.
  orgs_administradas as (
    select m.organization_id
    from public.organization_members m
    where m.user_id = (select auth.uid()) and m.role = 'ADMIN'
  ),
  visiveis as (
    select r.job_type, r.status, r.started_at, r.finished_at
    from public.job_runs r
    where r.organization_id in (select organization_id from orgs_administradas)
       or not exists (
         -- Job de plataforma: carimbado com uma organizacao que nao existe.
         select 1 from public.organizations o where o.id = r.organization_id
       )
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
    select distinct on (v.job_type)
           v.job_type, v.status, coalesce(v.finished_at, v.started_at) as quando
    from visiveis v
    order by v.job_type, coalesce(v.finished_at, v.started_at) desc
  ),
  falhas as (
    -- Sobre `visiveis`, nao sobre `job_runs`: o mesmo `job_type` roda em toda
    -- organizacao, entao a linha aparece legitimamente para varios ADMINs. O
    -- que nao pode vazar e o NUMERO.
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
  'Saude do Sistema (D-176): migration aplicada e ultima execucao de cada job, com idade e falhas em 24h. Le `supabase_migrations` (schema privado) via security definer, com autorizacao ADMIN refeita dentro. `job_runs` e escopado as organizacoes onde o chamador e ADMIN, mais os jobs de PLATAFORMA (organizacao inexistente no catalogo — o sentinela do `system.ping`), que e o que impede o escopo de apagar o heartbeat. Nao consulta o Google Cloud de proposito: observa o EFEITO (job rodou) em vez do agendamento.';
