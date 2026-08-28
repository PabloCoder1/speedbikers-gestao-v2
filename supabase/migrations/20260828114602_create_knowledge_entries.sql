-- Base de Conhecimento Validada (Fase 7B, D-071/D-113).
--
-- Fatos operacionais estruturados, consultados por SQL determinístico —
-- NUNCA RAG/embeddings/pgvector (D-071 é explícito; docs/COPILOT.md secao
-- 6). Um item nasce SUGERIDO por qualquer membro e só vira evidência para o
-- Copiloto quando um ADMIN/GESTOR o VALIDA: a confirmação humana explícita
-- é o que separa "alguém respondeu isso uma vez" de "fato confirmado"
-- (docs/PRODUCT_REQUIREMENTS.md, "Histórico de resposta não é
-- automaticamente verdade").
--
-- Sem DELETE para authenticated: conhecimento errado vira REJEITADO ou
-- OBSOLETO, preservando o histórico da decisão — apagar esconderia que a
-- equipe já acreditou naquilo. "Ativo/inativo" do requisito é coberto pelos
-- próprios estados (OBSOLETO), sem coluna redundante.

create table public.knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Nulo = conhecimento geral da operação (política de troca, prazo padrão);
  -- preenchido = fato de UM SKU (compatibilidade, especificação).
  sku_id uuid references public.skus(id) on delete cascade,
  kind text not null check (kind in ('COMPATIBILIDADE', 'ESPECIFICACAO', 'POLITICA', 'OUTRO')),
  content text not null check (char_length(btrim(content)) between 1 and 500),
  note text check (note is null or char_length(note) between 1 and 1000),
  source text not null check (source in ('CONFIRMACAO_INTERNA', 'FABRICANTE', 'DOCUMENTACAO', 'ATENDIMENTO')),
  status text not null default 'SUGERIDO'
    check (status in ('SUGERIDO', 'VALIDADO', 'REJEITADO', 'OBSOLETO')),
  created_by uuid references auth.users(id) on delete set null,
  confirmed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  updated_at timestamptz not null default now(),

  -- VALIDADO sem quem/quando validou seria confirmação anônima — o oposto
  -- do propósito da tabela.
  constraint knowledge_entries_validation_coherent check (
    (status = 'VALIDADO' and confirmed_by is not null and confirmed_at is not null)
    or status <> 'VALIDADO'
  )
);

comment on table public.knowledge_entries is
  'Base de Conhecimento Validada (D-071/D-113): fatos operacionais estruturados, consultados por SQL determinístico — NUNCA RAG/embeddings. Só status VALIDADO vira evidência para o Copiloto (suggest_support_reply). Qualquer membro registra como SUGERIDO; ADMIN/GESTOR validam (a validação humana explícita é o que separa "alguém respondeu isso uma vez" de "fato confirmado"). Sem DELETE para authenticated: conhecimento errado vira REJEITADO/OBSOLETO, preservando o histórico da decisão.';

create trigger knowledge_entries_set_updated_at
  before update on public.knowledge_entries
  for each row execute function private.set_updated_at();

-- O caminho quente da consulta do Copiloto: VALIDADO por SKU.
create index knowledge_entries_sku_validated_idx
  on public.knowledge_entries (organization_id, sku_id)
  where status = 'VALIDADO';

alter table public.knowledge_entries enable row level security;

create policy knowledge_entries_select_member
  on public.knowledge_entries for select
  to authenticated
  using (private.is_member_of(organization_id));

-- Qualquer membro SUGERE; o status nasce SUGERIDO por força do CHECK da
-- policy, nunca por confiança na UI.
create policy knowledge_entries_insert_member
  on public.knowledge_entries for insert
  to authenticated
  with check (
    private.is_member_of(organization_id)
    and created_by = (select auth.uid())
    and status = 'SUGERIDO'
  );

create policy knowledge_entries_update_admin
  on public.knowledge_entries for update
  to authenticated
  using (private.is_member_of(organization_id) and private.has_role(array['ADMIN', 'GESTOR']))
  with check (private.is_member_of(organization_id) and private.has_role(array['ADMIN', 'GESTOR']));

-- Todo GRANT de escrita tem policy correspondente (guard de D-098).
revoke all on public.knowledge_entries from anon, authenticated;
grant select, insert, update on public.knowledge_entries to authenticated;
grant all on public.knowledge_entries to service_role;
