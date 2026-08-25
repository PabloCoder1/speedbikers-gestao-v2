-- ============================================================
-- ai_runs — observabilidade de custo/uso do Copiloto (Fase 7, item 7,
-- D-077). docs/COPILOT.md secao 3: "toda chamada e' registrada em ai_runs
-- com custo, latencia, ferramentas usadas, escopo e periodo. Sem isso, o
-- custo e' descoberto na fatura."
--
-- Grava toda chamada a `POST /v1/copilot/query`, mesmo no caminho de
-- curto-circuito (ferramenta deterministica responde por completo, LLM
-- nunca chamado) -- `llm_used`/`cost_usd` distinguem os dois casos sem
-- precisar de duas tabelas. Escrita so por service_role: a `api` grava
-- depois de cada chamada, nenhum humano insere na mao (mesmo padrao de
-- domain_events/sync_runs).
-- ============================================================

create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,

  -- Nome(s) da(s) ferramenta(s) do registro (docs/COPILOT.md secao 4)
  -- efetivamente executada(s) nesta chamada. Array, nao coluna unica: um
  -- planner futuro pode encadear mais de uma ferramenta numa resposta so.
  tool_names text[] not null check (array_length(tool_names, 1) > 0),

  -- O que foi de fato consultado -- periodo, conta, o que mais a
  -- ferramenta aceitar. E' o "escopo" que docs/COPILOT.md secao 5 exige
  -- aparecer sempre na resposta; aqui e' o mesmo dado, gravado pra
  -- auditoria.
  scope jsonb not null,

  -- false em toda chamada desta fase (so ferramentas deterministicas,
  -- curto-circuito -- docs/HANDOFF.md item 7). Fica pronta para quando o
  -- planner por LLM existir (item 7 seguinte, pendente de escolha de
  -- modelo/orcamento, docs/COPILOT.md secao 10).
  llm_used boolean not null default false,

  -- Nulo enquanto llm_used = false -- custo de chamada deterministica e'
  -- zero de verdade, nao "zero desconhecido". Sem CHECK amarrando os dois
  -- porque o custo de um modelo especifico ainda nao foi decidido.
  cost_usd numeric,

  latency_ms integer not null check (latency_ms >= 0),

  created_at timestamptz not null default now()
);

comment on table public.ai_runs is
  'Observabilidade de uso/custo do Copiloto (docs/COPILOT.md secao 3) -- toda chamada a POST /v1/copilot/query, com ou sem LLM.';

create index ai_runs_organization_created_at_idx
  on public.ai_runs (organization_id, created_at desc);

-- ============================================================
-- RLS -- o proprio usuario ve o proprio historico; ADMIN/GESTOR veem o uso
-- da organizacao inteira (sao quem responde pela fatura). Mesmo padrao de
-- private.is_member_of/private.has_role ja usado no resto do schema.
-- ============================================================

alter table public.ai_runs enable row level security;

create policy ai_runs_select_own_or_admin
  on public.ai_runs for select to authenticated
  using (
    user_id = (select auth.uid())
    or (private.is_member_of(organization_id) and private.has_role(array['ADMIN', 'GESTOR']))
  );

grant select on public.ai_runs to authenticated;

grant select, insert on public.ai_runs to service_role;

revoke all on public.ai_runs from anon;
