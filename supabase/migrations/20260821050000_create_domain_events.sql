-- ============================================================
-- domain_events — o event store (Fase 3, motor de diff).
--
-- L2 (historico, append-only) — docs/ARCHITECTURE.md secao 9 e secao 13,
-- D-016. UMA tabela, carregando `before`/`after`, sem tabelas de snapshot
-- separadas: o estado atual ja vive em L1 (orders, e no futuro listings);
-- o que falta e O QUE MUDOU E QUANDO, e e exatamente isso que o evento
-- registra.
--
-- Isto NAO e event sourcing (D-016): L1 continua sendo a verdade e e
-- atualizado diretamente. O evento e registro do que mudou, nao o mecanismo
-- de reconstrucao do estado.
--
-- `event_type` segue o catalogo de docs/API.md secao 4, espelhado
-- executavel em packages/domain/src/events/catalog.ts.
-- ============================================================

create table public.domain_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- `restrict`, nao `cascade`: mesmo motivo de sync_runs/orders — historico
  -- nao pode desaparecer atras de uma exclusao de conta.
  ml_account_id uuid not null references public.ml_accounts(id) on delete restrict,

  -- Quando a mudanca ACONTECEU (ex.: orders.date_last_updated), nao quando
  -- o V3 notou — a varredura pode rodar minutos ou horas depois do fato.
  occurred_at timestamptz not null,

  -- dominio.entidade.acao (docs/API.md secao 4). Texto livre, nao enum: o
  -- catalogo evolui em packages/domain, uma constraint aqui duplicaria a
  -- fonte da verdade e teria que ser migrada toda vez que um evento novo
  -- nascesse.
  event_type text not null check (char_length(event_type) between 1 and 100),

  entity_type text not null check (char_length(entity_type) between 1 and 50),
  entity_id text not null check (char_length(entity_id) between 1 and 100),

  before jsonb,
  after jsonb,

  severity text not null check (severity in ('informativo', 'importante', 'critico')),
  source text not null check (source in ('webhook', 'sync', 'user', 'system')),

  -- Determinístico por natureza do evento (packages/domain/src/events).
  -- UNIQUE e o que faz reprocessar um job NAO duplicar evento — a mesma
  -- transicao detectada duas vezes (sobreposicao de janela de
  -- reconciliacao, corrida entre execucoes) produz a MESMA chave.
  dedup_key text not null unique,

  created_at timestamptz not null default now()
);

comment on table public.domain_events is
  'Event store L2 append-only (D-016): before/after, sem tabela de snapshot separada. dedup_key UNIQUE evita evento duplicado.';

comment on column public.domain_events.occurred_at is
  'Quando a mudanca aconteceu de verdade, nao quando o V3 notou (pode ser um backfill de meses atras).';

comment on column public.domain_events.dedup_key is
  'Determinístico por evento (packages/domain/src/events). Reprocessar o mesmo job nao duplica linha.';

-- Linha do tempo de uma conta (tela de Saude da Sincronizacao, notificacoes).
create index domain_events_account_timeline_idx
  on public.domain_events (ml_account_id, occurred_at desc);

-- "O que aconteceu com ESTA entidade" — a consulta que D-016 aceitou pagar
-- (replay de eventos) em troca de nao manter snapshot completo.
create index domain_events_entity_idx
  on public.domain_events (organization_id, entity_type, entity_id, occurred_at desc);

create index domain_events_type_idx
  on public.domain_events (organization_id, event_type);

-- ============================================================
-- Append-only, imposto pelo banco — mesmo mecanismo de job_runs/sync_runs.
-- ============================================================

create or replace function public.domain_events_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'domain_events e append-only: % nao e permitido. Corrija inserindo uma nova linha.',
    tg_op;
end;
$$;

create trigger domain_events_no_update
  before update on public.domain_events
  for each row execute function public.domain_events_reject_mutation();

create trigger domain_events_no_delete
  before delete on public.domain_events
  for each row execute function public.domain_events_reject_mutation();

-- ============================================================
-- RLS — observabilidade PARA O USUARIO (mesmo padrao de sync_runs, nao o
-- fechamento total de job_runs): quem alcanca a conta ve os eventos dela.
-- Escrita continua so por service_role: nenhum humano registra evento na
-- mao.
-- ============================================================

alter table public.domain_events enable row level security;

create policy domain_events_select_permitted
  on public.domain_events for select to authenticated
  using (private.has_account_access(ml_account_id));

grant select on public.domain_events to authenticated;

grant select, insert on public.domain_events to service_role;

revoke all on public.domain_events from anon;
