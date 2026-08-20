-- ============================================================
-- job_runs — registro do que cada job executou.
--
-- Camada L2 (histórico, append-only). Ver docs/DATABASE.md secao 1.
--
-- Existe porque a fila é o Cloud Tasks (D-014) e ela não é consultável por SQL.
-- Perdemos a visão do PENDENTE e mantemos a visão completa do EXECUTADO — e é
-- o executado que se investiga.
--
-- Esta é infraestrutura, não domínio: nenhuma regra de negócio depende dela.
-- ============================================================

create table public.job_runs (
  id uuid primary key default gen_random_uuid(),

  -- Sem chave estrangeira ainda: `organizations` só nasce na Fase 2. A coluna
  -- entra agora porque `organization_id` é a chave de partição de toda tabela
  -- (D-031) e adicioná-la depois custa muito mais do que mantê-la.
  organization_id uuid not null,

  -- Identificadores vindos do envelope do job (@sb/contracts).
  job_id uuid not null,
  job_type text not null check (char_length(job_type) between 1 and 120),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 500),
  attempt integer not null check (attempt >= 1),

  status text not null check (status in ('done', 'failed')),

  -- Só preenchidos quando `status = 'failed'`. `retryable` distingue a falha
  -- transitória (503, a fila repete) da definitiva (422, a fila descarta).
  retryable boolean,
  reason text,

  processed integer check (processed is null or processed >= 0),

  started_at timestamptz not null,
  finished_at timestamptz not null,

  duration_ms integer generated always as (
    floor(extract(epoch from (finished_at - started_at)) * 1000)::integer
  ) stored,

  created_at timestamptz not null default now(),

  constraint job_runs_finished_after_started
    check (finished_at >= started_at),

  -- Coerência entre status e campos de falha: uma linha `done` com motivo de
  -- erro, ou uma `failed` sem classificação de retry, é dado corrompido.
  constraint job_runs_failure_fields_match_status check (
    (status = 'done' and retryable is null and reason is null)
    or
    (status = 'failed' and retryable is not null)
  )
);

comment on table public.job_runs is
  'Historico append-only de execucoes de job. Camada L2. Infraestrutura, nao dominio.';

comment on column public.job_runs.dedupe_key is
  'Chave logica do trabalho. Duas execucoes com a mesma chave representam o mesmo trabalho.';

comment on column public.job_runs.retryable is
  'Apenas para status failed. true = fila repete (503); false = fila descarta (422).';

-- ============================================================
-- Índice
--
-- Um só, para o padrão de consulta que realmente existe hoje: "o que rodou
-- recentemente nesta organização". Mais índices entram com consulta medida —
-- a V2 sofreu por índice ausente E por índice genérico que nunca era usado.
-- ============================================================

create index job_runs_recent_idx
  on public.job_runs (organization_id, finished_at desc);

-- ============================================================
-- Append-only, imposto pelo banco
--
-- `docs/DATABASE.md` diz que L2 nunca sofre UPDATE. Aqui isso deixa de ser
-- convenção e passa a ser garantia: nem a service_role consegue alterar.
-- ============================================================

create or replace function public.job_runs_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'job_runs e append-only: % nao e permitido. Corrija inserindo uma nova linha.',
    tg_op;
end;
$$;

comment on function public.job_runs_reject_mutation is
  'Impede UPDATE e DELETE em job_runs, tornando o contrato append-only fisico.';

create trigger job_runs_no_update
  before update on public.job_runs
  for each row execute function public.job_runs_reject_mutation();

create trigger job_runs_no_delete
  before delete on public.job_runs
  for each row execute function public.job_runs_reject_mutation();

-- ============================================================
-- RLS
--
-- Habilitada e SEM NENHUMA POLICY, deliberadamente.
--
-- Sem policy, ninguem le nem escreve pela Data API — nem `anon`, nem
-- `authenticated`. Só a `service_role`, que ignora RLS por definicao e e usada
-- exclusivamente por apps/api e apps/worker (D-012).
--
-- As policies de leitura entram na Fase 2, junto com `organizations` e os
-- helpers `current_org_id()` / `has_role()`. Abrir leitura agora exigiria uma
-- policy permissiva sem ninguem para autorizar, que e exatamente o tipo de
-- brecha que se esquece de fechar.
-- ============================================================

alter table public.job_runs enable row level security;
