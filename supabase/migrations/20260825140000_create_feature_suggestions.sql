-- ============================================================
-- feature_suggestions — Sugestões de features via Copiloto (Fase 7,
-- item 9, D-079). docs/PRODUCT_REQUIREMENTS.md secao "Sugestões de
-- features via Copiloto", docs/COPILOT.md secao 8.
--
-- "Usuários autorizados poderão enviar ideias de melhoria em linguagem
-- natural pelo assistente. A IA deve preservar a mensagem original e
-- gerar uma versão estruturada com, quando possível: título, problema,
-- objetivo, usuários impactados, fluxo sugerido, benefício esperado,
-- critérios de aceite sugeridos, dependências/riscos aparentes,
-- complexidade a avaliar, autor e data."
--
-- Esta migration cria o schema completo (captura + Central de
-- Sugestões), mas os NOVE campos estruturados nascem NULL — são
-- preenchidos pela IA, e o Copiloto ainda não tem modelo/orçamento
-- decidido (docs/COPILOT.md secao 10, pendência real, não uma tarefa
-- técnica). Mesmo raciocínio já usado para notification_preferences
-- (Fase 2) e ai_runs (D-077): schema pronto agora, funcionalidade
-- completa depois, sem migration chata quando o LLM existir.
-- ============================================================

create table public.feature_suggestions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,

  -- Preservado ÍNTEGRO, nunca sobrescrito (docs/COPILOT.md secao 8:
  -- "a estruturação pode errar a intenção... o que o usuário realmente
  -- escreveu é a única fonte confiável. Sobrescrever perde informação de
  -- forma irreversível.").
  original_text text not null check (char_length(btrim(original_text)) between 1 and 5000),

  -- Versão estruturada — gerada pela IA "quando possível" (requisito).
  -- Nula até o Copiloto ter essa capacidade; sem UI de preenchimento
  -- manual nesta fatia (não é o que o requisito pede — "a IA deve
  -- gerar", não "alguém preenche à mão").
  title text,
  problem text,
  objective text,
  impacted_users text,
  suggested_flow text,
  expected_benefit text,
  acceptance_criteria text,
  dependencies_risks text,
  complexity text,

  -- Sete estados, ordem e nomes exatos do requisito.
  status text not null default 'nova'
    check (status in ('nova', 'em_analise', 'aprovada', 'planejada', 'em_desenvolvimento', 'entregue', 'recusada')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.feature_suggestions is
  'Sugestões de features via Copiloto (docs/PRODUCT_REQUIREMENTS.md). original_text nunca é sobrescrito; campos estruturados nascem null até o Copiloto ter LLM (docs/COPILOT.md secao 10).';

comment on column public.feature_suggestions.original_text is
  'Texto livre do usuário, íntegro. Fonte confiável mesmo se a versão estruturada errar a intenção.';

create index feature_suggestions_organization_status_idx
  on public.feature_suggestions (organization_id, status, created_at desc);

create trigger feature_suggestions_set_updated_at
  before update on public.feature_suggestions
  for each row execute function private.set_updated_at();

-- ============================================================
-- RLS — qualquer membro da organização envia e lê (é um canal de
-- feedback, não um dado sensível por usuário); só ADMIN/GESTOR muda o
-- estado de triagem (mesma granularidade de purchase_orders/actions).
-- ============================================================

alter table public.feature_suggestions enable row level security;

create policy feature_suggestions_select_org
  on public.feature_suggestions for select to authenticated
  using (private.is_member_of(organization_id));

create policy feature_suggestions_insert_own
  on public.feature_suggestions for insert to authenticated
  with check (private.is_member_of(organization_id) and created_by = (select auth.uid()));

create policy feature_suggestions_update_admin
  on public.feature_suggestions for update to authenticated
  using (private.is_member_of(organization_id) and private.has_role(array['ADMIN', 'GESTOR']))
  with check (private.is_member_of(organization_id) and private.has_role(array['ADMIN', 'GESTOR']));

grant select, insert, update on public.feature_suggestions to authenticated;
grant select, insert, update, delete on public.feature_suggestions to service_role;

revoke all on public.feature_suggestions from anon;
