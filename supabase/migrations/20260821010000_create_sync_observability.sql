-- ============================================================
-- sync_runs / sync_errors — observabilidade de sincronização com o
-- Mercado Livre, por conta.
--
-- Camada L2 (histórico, append-only), mesmo padrão de `job_runs`
-- (`supabase/migrations/20260820130000_create_job_runs.sql`): o Postgres
-- registra o EXECUTADO, não a fila.
--
-- Schema apenas — nada escreve aqui ainda. O sync do Mercado Livre (webhook,
-- reconciliação, backfill) é Fase 3 e depende da confirmação da documentação
-- oficial (`docs/MERCADO_LIVRE.md`). Criar a tabela agora não antecipa
-- nenhum campo de payload do ML: `resource` e `channel` só nomeiam o que já
-- está aprovado em `docs/ARCHITECTURE.md` secao 10 e `docs/MERCADO_LIVRE.md`
-- secao 3 — três canais, três recursos —, nada além disso.
--
-- `sync_runs` é o dado que a tela de Saúde da Sincronização (Fase 3) vai
-- comparar contra `now()` para responder "os dados desta conta estão
-- atualizados?" (docs/MERCADO_LIVRE.md secao 3, docs/ARCHITECTURE.md secao 10).
-- ============================================================

-- ============================================================
-- 1. sync_runs
-- ============================================================

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- `restrict`, não `cascade`: histórico append-only não pode desaparecer em
  -- silêncio atrás de um DELETE de conta, e a trigger da secao 3 bloquearia a
  -- cascata de qualquer forma (ela recusa TODO delete, inclusive o
  -- disparado por FK). Na prática nunca dispara — contas são desativadas por
  -- `status = 'REVOKED'`, nunca apagadas (`docs/DATABASE.md`).
  ml_account_id uuid not null references public.ml_accounts(id) on delete restrict,

  -- Job do worker que produziu esta execução. Sem FK para `job_runs`
  -- (mesma escolha de `job_runs.job_id`: identificador vindo do envelope,
  -- não chave de junção garantida) — correlaciona por igualdade quando
  -- investigar.
  job_id uuid not null,

  resource text not null check (resource in ('orders', 'listings', 'fulfillment')),
  channel text not null check (channel in ('webhook', 'reconciliation', 'backfill')),

  status text not null check (status in ('done', 'failed', 'partial')),

  -- Só preenchido quando não terminou 100% certo — mesma regra de
  -- `job_runs_failure_fields_match_status`.
  reason text,

  items_processed integer check (items_processed is null or items_processed >= 0),

  -- Registro mais recente que ESTA execução efetivamente trouxe. É o que
  -- vira "dado atualizado até HH:MM" na tela — não é `finished_at`, porque a
  -- sincronização pode terminar sem ter trazido nada novo.
  latest_record_at timestamptz,

  started_at timestamptz not null,
  finished_at timestamptz not null,

  created_at timestamptz not null default now(),

  constraint sync_runs_finished_after_started check (finished_at >= started_at),

  constraint sync_runs_reason_matches_status check (
    (status = 'done' and reason is null) or status <> 'done'
  )
);

comment on table public.sync_runs is
  'Historico append-only de sincronizacao com o Mercado Livre, por conta e recurso. Camada L2.';

comment on column public.sync_runs.latest_record_at is
  'Registro mais recente trazido por esta execucao. Base do calculo de atraso da tela de Saude da Sincronizacao.';

comment on column public.sync_runs.channel is
  'webhook = caminho principal. reconciliation = rede de seguranca por janela. backfill = historia, fila de prioridade baixa.';

-- Consulta que sustenta a tela: "qual foi a ultima sincronizacao desta conta
-- neste recurso?" — um `order by finished_at desc limit 1` por
-- (ml_account_id, resource).
create index sync_runs_freshness_idx
  on public.sync_runs (ml_account_id, resource, finished_at desc);

-- ============================================================
-- 2. sync_errors
--
-- Tabela separada de `sync_runs` de proposito: uma execucao pode falhar em
-- varios itens sem que a execucao inteira falhe (`status = 'partial'`), e
-- cada erro individual carrega sua propria classificacao de retry
-- (`docs/API.md` secao 6) para decidir o proximo passo sem reabrir a run.
-- ============================================================

create table public.sync_errors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- `restrict`: mesmo motivo de sync_runs.ml_account_id, acima.
  ml_account_id uuid not null references public.ml_accounts(id) on delete restrict,

  -- Nulo quando o erro aconteceu fora de uma execucao rastreada (ex.: antes
  -- de a sync_run ser criada).
  sync_run_id uuid references public.sync_runs(id) on delete set null,

  resource text not null check (resource in ('orders', 'listings', 'fulfillment')),

  -- Mesma classificacao de docs/API.md secao 6.
  error_class text not null
    check (error_class in ('retryable', 'retryable_eventual', 'not_retryable')),

  message text not null check (char_length(message) between 1 and 2000),

  occurred_at timestamptz not null,

  created_at timestamptz not null default now()
);

comment on table public.sync_errors is
  'Historico append-only de erros de sincronizacao individuais. Camada L2.';

comment on column public.sync_errors.error_class is
  'Classificacao de docs/API.md secao 6: retryable (429/5xx), retryable_eventual (404 por consistencia eventual), not_retryable (401/403/payload invalido).';

create index sync_errors_recent_idx
  on public.sync_errors (ml_account_id, occurred_at desc);

-- ============================================================
-- 3. Append-only, imposto pelo banco
--
-- Mesmo mecanismo de job_runs: nem service_role consegue alterar ou apagar.
-- ============================================================

create or replace function public.sync_runs_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'sync_runs e append-only: % nao e permitido. Corrija inserindo uma nova linha.',
    tg_op;
end;
$$;

create trigger sync_runs_no_update
  before update on public.sync_runs
  for each row execute function public.sync_runs_reject_mutation();

create trigger sync_runs_no_delete
  before delete on public.sync_runs
  for each row execute function public.sync_runs_reject_mutation();

create or replace function public.sync_errors_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'sync_errors e append-only: % nao e permitido. Corrija inserindo uma nova linha.',
    tg_op;
end;
$$;

create trigger sync_errors_no_update
  before update on public.sync_errors
  for each row execute function public.sync_errors_reject_mutation();

create trigger sync_errors_no_delete
  before delete on public.sync_errors
  for each row execute function public.sync_errors_reject_mutation();

-- ============================================================
-- 4. RLS
--
-- Diferente de job_runs (fechada de proposito ate existir quem autorizar):
-- aqui `organizations`, `ml_accounts` e `has_account_access` ja existem. E
-- observabilidade PARA O USUARIO (docs/ARCHITECTURE.md secao 10) — quem
-- alcanca a conta ve a saude da sincronizacao dela. Escrita continua so por
-- service_role: nenhum humano registra uma execucao de sync na mao.
-- ============================================================

alter table public.sync_runs enable row level security;
alter table public.sync_errors enable row level security;

create policy sync_runs_select_permitted
  on public.sync_runs for select to authenticated
  using (private.has_account_access(ml_account_id));

create policy sync_errors_select_permitted
  on public.sync_errors for select to authenticated
  using (private.has_account_access(ml_account_id));

-- ============================================================
-- 5. GRANTs
-- ============================================================

grant select on public.sync_runs, public.sync_errors to authenticated;

grant select, insert on public.sync_runs, public.sync_errors to service_role;

revoke all on public.sync_runs from anon;
revoke all on public.sync_errors from anon;
