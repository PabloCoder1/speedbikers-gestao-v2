-- Templates de resposta do atendimento (Fase 7B, D-111).
--
-- A tabela era conceitual desde D-084/D-085 ("knowledge_entries ·
-- reply_templates — conceituais", docs/DATABASE.md). Esta fatia materializa
-- SÓ reply_templates: texto pronto que a operação insere na caixa de
-- resposta (D-096) e EDITA antes de confirmar — o requisito é explícito em
-- que template não substitui o contexto do atendimento, então inserir é
-- pré-preencher, nunca enviar.
--
-- Compartilhado pela ORGANIZAÇÃO, não por usuário (diferente de
-- saved_filters): o valor do template é a equipe convergir na mesma
-- resposta. Escrita restrita a ADMIN/GESTOR pelo MESMO padrão de
-- feature_suggestions (D-079): RLS direta com policy checando papel, sem
-- RPC — não há transação multi-tabela que justifique security definer.
--
-- `body` tem o MESMO teto da caixa de resposta (2000): um template maior
-- que o campo onde ele será colado é um template que nunca cabe.

create table public.reply_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- `set null`, não `restrict`: o template sobrevive ao autor sair, e
  -- restrict travaria a limpeza de usuários (autoria aqui é contexto, não
  -- auditoria — a resposta ENVIADA continua auditada em
  -- support_reply_attempts, com o texto efetivo e quem confirmou).
  created_by uuid references auth.users(id) on delete set null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (organization_id, name)
);

comment on table public.reply_templates is
  'Templates de resposta do atendimento (D-111). Compartilhados pela organização; ADMIN/GESTOR gerenciam (RLS direta, padrão feature_suggestions), qualquer membro lê e insere na caixa de resposta para EDITAR antes de confirmar. Sem placeholders nesta fatia: {nome} exigiria o nome do comprador, que a V3 não tem de forma confiável (customer_external_id é ID numérico e D-083 proíbe confiar em from/to) — substituir por dado errado numa mensagem ao cliente é pior que não substituir.';

create trigger reply_templates_set_updated_at
  before update on public.reply_templates
  for each row execute function private.set_updated_at();

create index reply_templates_org_idx on public.reply_templates (organization_id, name);

alter table public.reply_templates enable row level security;

create policy reply_templates_select_member
  on public.reply_templates for select
  to authenticated
  using (private.is_member_of(organization_id));

create policy reply_templates_insert_admin
  on public.reply_templates for insert
  to authenticated
  with check (
    private.is_member_of(organization_id)
    and private.has_role(array['ADMIN', 'GESTOR'])
    and created_by = (select auth.uid())
  );

create policy reply_templates_update_admin
  on public.reply_templates for update
  to authenticated
  using (private.is_member_of(organization_id) and private.has_role(array['ADMIN', 'GESTOR']))
  with check (private.is_member_of(organization_id) and private.has_role(array['ADMIN', 'GESTOR']));

create policy reply_templates_delete_admin
  on public.reply_templates for delete
  to authenticated
  using (private.is_member_of(organization_id) and private.has_role(array['ADMIN', 'GESTOR']));

-- Todo GRANT de escrita abaixo tem a policy correspondente acima — o
-- invariante que o teste-guarda de D-098 verifica a cada rodada da CI.
revoke all on public.reply_templates from anon, authenticated;
grant select, insert, update, delete on public.reply_templates to authenticated;
grant all on public.reply_templates to service_role;
