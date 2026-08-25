-- ============================================================
-- Fase 7B / D-085 — núcleo read-only da Central de Atendimento,
-- implementando o modelo aprovado em D-084.
--
-- Esta migration cria SOMENTE a persistência e a segurança do read model.
-- Não consome webhook, não chama o Mercado Livre, não cria UI e não envia
-- respostas. O worker futuro fará upsert das projeções L1; resposta manual,
-- knowledge_entries e reply_templates entram em fatias posteriores.
--
-- Identidade externa preservada:
--   QUESTION          -> question:{question_id}
--   POST_SALE_MESSAGE -> message:pack:{pack_id} | message:order:{order_id}
--   CLAIM             -> claim:{claim_id}
--
-- Mediação e devolução são facetas do CLAIM, não cases duplicados.
-- ============================================================

-- ============================================================
-- 1. support_cases — L1, estado atual da caixa de entrada
-- ============================================================

create table public.support_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- Restrict: histórico de atendimento não pode desaparecer ao apagar conta.
  ml_account_id uuid not null references public.ml_accounts(id) on delete restrict,

  channel text not null
    check (channel in ('QUESTION', 'POST_SALE_MESSAGE', 'CLAIM')),
  external_case_key text not null
    check (char_length(btrim(external_case_key)) between 1 and 240),
  external_case_id text not null
    check (
      char_length(btrim(external_case_id)) between 1 and 120
      and external_case_id ~ '^[0-9]+$'
    ),

  pack_id bigint check (pack_id is null or pack_id > 0),
  external_status text,
  external_substatus text,
  external_stage text,
  external_type text,

  is_mediation boolean not null default false,
  has_return boolean not null default false,

  -- Exibição/contexto somente; D-083 proíbe usar comprador/from/to como ID.
  customer_external_id bigint
    check (customer_external_id is null or customer_external_id > 0),
  conversation_path text,

  remote_unread_count integer not null default 0
    check (remote_unread_count >= 0),
  remote_reply_state text not null default 'UNKNOWN'
    check (remote_reply_state in ('UNKNOWN', 'ALLOWED', 'BLOCKED')),
  remote_reply_block_reason text,

  internal_status text not null default 'NOVO'
    check (internal_status in (
      'NOVO', 'EM_ATENDIMENTO', 'AGUARDANDO_CLIENTE',
      'AGUARDANDO_MERCADO_LIVRE', 'RESOLVIDO'
    )),
  priority text not null default 'NORMAL'
    check (priority in ('NORMAL', 'ALTA', 'CRITICA')),
  assignee_id uuid references public.profiles(id) on delete set null,

  last_activity_at timestamptz not null,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  resolved_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint support_cases_external_identity_unique
    unique (organization_id, ml_account_id, channel, external_case_key),

  -- Alvo das FKs compostas dos filhos: impede conta/org divergente do case.
  constraint support_cases_id_scope_unique
    unique (id, organization_id, ml_account_id),

  constraint support_cases_external_key_coherent check (
    (channel = 'QUESTION' and external_case_key = 'question:' || external_case_id)
    or (
      channel = 'POST_SALE_MESSAGE'
      and external_case_key in (
        'message:pack:' || external_case_id,
        'message:order:' || external_case_id
      )
    )
    or (channel = 'CLAIM' and external_case_key = 'claim:' || external_case_id)
  ),

  constraint support_cases_claim_facets_coherent check (
    (not is_mediation and not has_return) or channel = 'CLAIM'
  ),

  constraint support_cases_resolution_coherent check (
    (internal_status = 'RESOLVIDO' and resolved_at is not null)
    or (internal_status <> 'RESOLVIDO' and resolved_at is null)
  )
);

comment on table public.support_cases is
  'Projeção L1 da caixa unificada de atendimento (D-084). Um case é QUESTION, conversa POST_SALE_MESSAGE ou CLAIM.';

comment on column public.support_cases.external_case_key is
  'Chave determinística por canal; com org/conta/canal sustenta idempotência de webhook e reconciliação.';

comment on column public.support_cases.remote_reply_state is
  'Hint remoto atual para UI. ALLOWED nunca substitui refresh/validação na hora de enviar.';

create index support_cases_open_inbox_idx
  on public.support_cases (organization_id, internal_status, last_activity_at desc)
  where internal_status <> 'RESOLVIDO';

create index support_cases_account_inbox_idx
  on public.support_cases (ml_account_id, internal_status, last_activity_at desc);

create index support_cases_assignee_open_idx
  on public.support_cases (organization_id, assignee_id, internal_status)
  where assignee_id is not null and internal_status <> 'RESOLVIDO';

create trigger support_cases_set_updated_at
  before update on public.support_cases
  for each row execute function private.set_updated_at();

-- ============================================================
-- 2. support_messages — L1, transcript remoto atual
-- ============================================================

create table public.support_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  ml_account_id uuid not null,
  support_case_id uuid not null,

  external_message_key text not null
    check (char_length(btrim(external_message_key)) between 1 and 300),
  external_message_id text
    check (external_message_id is null or char_length(btrim(external_message_id)) between 1 and 200),

  direction text not null
    check (direction in ('INBOUND', 'OUTBOUND', 'SYSTEM')),
  sender_kind text not null
    check (sender_kind in (
      'CUSTOMER', 'SELLER', 'MERCADO_LIVRE_AGENT',
      'MEDIATOR', 'SYSTEM', 'UNKNOWN'
    )),

  remote_from_user_id bigint
    check (remote_from_user_id is null or remote_from_user_id > 0),
  remote_to_user_id bigint
    check (remote_to_user_id is null or remote_to_user_id > 0),

  body text,
  body_state text not null default 'AVAILABLE'
    check (body_state in ('AVAILABLE', 'EMPTY', 'BANNED', 'MODERATED', 'UNAVAILABLE')),
  remote_status text,

  occurred_at timestamptz not null,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint support_messages_case_scope_fkey
    foreign key (support_case_id, organization_id, ml_account_id)
    references public.support_cases (id, organization_id, ml_account_id)
    on delete cascade,

  constraint support_messages_external_identity_unique
    unique (support_case_id, external_message_key),

  constraint support_messages_id_scope_unique
    unique (id, organization_id, ml_account_id)
);

comment on table public.support_messages is
  'Unidade de comunicação do transcript. Projeção L1: status/moderação remotos podem mudar por upsert.';

comment on column public.support_messages.body_state is
  'Distingue texto vazio legítimo de conteúdo banido, moderado ou indisponível.';

create index support_messages_case_timeline_idx
  on public.support_messages (support_case_id, occurred_at, id);

create index support_messages_account_timeline_idx
  on public.support_messages (ml_account_id, occurred_at desc);

create trigger support_messages_set_updated_at
  before update on public.support_messages
  for each row execute function private.set_updated_at();

-- ============================================================
-- 3. support_case_links — relações muitos-para-muitos do read model
-- ============================================================

create table public.support_case_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  ml_account_id uuid not null,
  support_case_id uuid not null,

  order_id bigint references public.orders(id) on delete restrict,
  sku_id uuid references public.skus(id) on delete restrict,
  listing_id uuid references public.listings(id) on delete restrict,
  external_entity_kind text
    check (external_entity_kind is null or char_length(btrim(external_entity_kind)) between 1 and 60),
  external_entity_id text
    check (external_entity_id is null or char_length(btrim(external_entity_id)) between 1 and 200),

  link_source text not null
    check (link_source in ('REMOTE', 'ORDER_DERIVED', 'LISTING_DERIVED', 'MANUAL')),
  created_at timestamptz not null default now(),

  constraint support_case_links_case_scope_fkey
    foreign key (support_case_id, organization_id, ml_account_id)
    references public.support_cases (id, organization_id, ml_account_id)
    on delete cascade,

  constraint support_case_links_external_pair_coherent check (
    (external_entity_kind is null) = (external_entity_id is null)
  ),

  constraint support_case_links_exactly_one_target check (
    num_nonnulls(order_id, sku_id, listing_id)
    + case when external_entity_kind is not null then 1 else 0 end
    = 1
  )
);

comment on table public.support_case_links is
  'Read model muitos-para-muitos entre atendimento e pedidos/SKUs/anúncios ou entidade externa explícita.';

create unique index support_case_links_order_unique
  on public.support_case_links (support_case_id, order_id)
  where order_id is not null;

create unique index support_case_links_sku_unique
  on public.support_case_links (support_case_id, sku_id)
  where sku_id is not null;

create unique index support_case_links_listing_unique
  on public.support_case_links (support_case_id, listing_id)
  where listing_id is not null;

create unique index support_case_links_external_unique
  on public.support_case_links (support_case_id, external_entity_kind, external_entity_id)
  where external_entity_kind is not null;

create index support_case_links_case_idx
  on public.support_case_links (support_case_id);

-- Índices separados: os UNIQUE acima começam por case_id e não ajudam o lado
-- referenciado de FK em DELETE/UPDATE.
create index support_case_links_order_idx
  on public.support_case_links (order_id)
  where order_id is not null;

create index support_case_links_sku_idx
  on public.support_case_links (sku_id)
  where sku_id is not null;

create index support_case_links_listing_idx
  on public.support_case_links (listing_id)
  where listing_id is not null;

-- FK simples prova existência. Este trigger prova também o escopo do alvo sem
-- criar índices UNIQUE redundantes em orders/listings/skus só para FK composta.
create or replace function private.support_case_links_validate_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.order_id is not null and not exists (
    select 1
    from public.orders o
    where o.id = new.order_id
      and o.organization_id = new.organization_id
      and o.ml_account_id = new.ml_account_id
  ) then
    raise exception 'support_case_links: pedido fora da organização/conta do case'
      using errcode = '23514';
  end if;

  if new.sku_id is not null and not exists (
    select 1
    from public.skus s
    where s.id = new.sku_id
      and s.organization_id = new.organization_id
  ) then
    raise exception 'support_case_links: SKU fora da organização do case'
      using errcode = '23514';
  end if;

  if new.listing_id is not null and not exists (
    select 1
    from public.listings l
    where l.id = new.listing_id
      and l.organization_id = new.organization_id
      and l.ml_account_id = new.ml_account_id
  ) then
    raise exception 'support_case_links: anúncio fora da organização/conta do case'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.support_case_links_validate_scope()
  from public, anon, authenticated;

create trigger support_case_links_validate_scope
  before insert or update on public.support_case_links
  for each row execute function private.support_case_links_validate_scope();

-- ============================================================
-- 4. support_case_deadlines — L1, prazos atuais por fonte
-- ============================================================

create table public.support_case_deadlines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  ml_account_id uuid not null,
  support_case_id uuid not null,

  deadline_kind text not null
    check (deadline_kind in ('FIRST_RESPONSE', 'NEXT_ACTION', 'RESOLUTION')),
  source text not null
    check (source in (
      'INTERNAL_POLICY', 'ML_MESSAGE_RULE',
      'ML_CLAIM_DETAIL', 'ML_AVAILABLE_ACTION'
    )),
  source_reference text
    check (source_reference is null or char_length(btrim(source_reference)) between 1 and 240),
  policy_key text
    check (policy_key is null or char_length(btrim(policy_key)) between 1 and 120),

  started_at timestamptz,
  due_at timestamptz,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'MET', 'BREACHED', 'CANCELLED')),
  met_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint support_case_deadlines_case_scope_fkey
    foreign key (support_case_id, organization_id, ml_account_id)
    references public.support_cases (id, organization_id, ml_account_id)
    on delete cascade,

  -- NULL também colide: um prazo sem source_reference continua sendo único.
  constraint support_case_deadlines_identity_unique
    unique nulls not distinct (support_case_id, deadline_kind, source, source_reference),

  constraint support_case_deadlines_met_coherent check (
    (status = 'MET' and met_at is not null)
    or (status <> 'MET' and met_at is null)
  )
);

comment on table public.support_case_deadlines is
  'Prazos atuais do atendimento, sempre com fonte. Pergunta sem política não ganha prazo inventado.';

create index support_case_deadlines_active_due_idx
  on public.support_case_deadlines (organization_id, due_at)
  where status = 'ACTIVE' and due_at is not null;

create index support_case_deadlines_account_idx
  on public.support_case_deadlines (ml_account_id, status, due_at);

create trigger support_case_deadlines_set_updated_at
  before update on public.support_case_deadlines
  for each row execute function private.set_updated_at();

-- ============================================================
-- 5. support_attachments — L1, metadados/ponteiro; nunca binário no Postgres
-- ============================================================

create table public.support_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  ml_account_id uuid not null,
  support_message_id uuid not null,

  external_attachment_key text not null
    check (char_length(btrim(external_attachment_key)) between 1 and 300),
  file_name text
    check (file_name is null or char_length(file_name) between 1 and 200),
  mime_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  remote_reference text,
  cached_object_path text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint support_attachments_message_scope_fkey
    foreign key (support_message_id, organization_id, ml_account_id)
    references public.support_messages (id, organization_id, ml_account_id)
    on delete cascade,

  constraint support_attachments_external_identity_unique
    unique (support_message_id, external_attachment_key)
);

comment on table public.support_attachments is
  'Metadados de anexo de atendimento. Binário não vive no Postgres; ponteiro nunca é URL pública permanente.';

create index support_attachments_account_idx
  on public.support_attachments (ml_account_id, created_at desc);

create trigger support_attachments_set_updated_at
  before update on public.support_attachments
  for each row execute function private.set_updated_at();

-- ============================================================
-- 6. support_case_events — L2, auditoria detalhada append-only
-- ============================================================

create table public.support_case_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  ml_account_id uuid not null,
  support_case_id uuid not null,

  event_type text not null
    check (char_length(btrim(event_type)) between 1 and 100),
  source text not null
    check (source in ('WEBHOOK', 'RECONCILIATION', 'USER', 'SYSTEM')),
  actor_user_id uuid references public.profiles(id) on delete set null,
  before jsonb,
  after jsonb,

  occurred_at timestamptz not null,
  dedup_key text not null
    check (char_length(btrim(dedup_key)) between 1 and 500),
  created_at timestamptz not null default now(),

  constraint support_case_events_case_scope_fkey
    foreign key (support_case_id, organization_id, ml_account_id)
    references public.support_cases (id, organization_id, ml_account_id)
    on delete cascade,

  constraint support_case_events_dedup_unique
    unique (organization_id, dedup_key)
);

comment on table public.support_case_events is
  'Auditoria L2 append-only do atendimento. Não gera notificação automaticamente; promoção a domain_events é explícita.';

create index support_case_events_case_timeline_idx
  on public.support_case_events (support_case_id, occurred_at desc);

create index support_case_events_account_timeline_idx
  on public.support_case_events (ml_account_id, occurred_at desc);

create or replace function private.support_case_events_reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'support_case_events e append-only: % nao e permitido. Insira um novo evento.',
    tg_op;
end;
$$;

revoke all on function private.support_case_events_reject_mutation()
  from public, anon, authenticated;

create trigger support_case_events_no_mutation
  before update or delete on public.support_case_events
  for each row execute function private.support_case_events_reject_mutation();

-- ============================================================
-- 7. RLS — leitura direta do web por conta; escrita só pelo backend
-- ============================================================

alter table public.support_cases enable row level security;
alter table public.support_messages enable row level security;
alter table public.support_case_links enable row level security;
alter table public.support_case_deadlines enable row level security;
alter table public.support_attachments enable row level security;
alter table public.support_case_events enable row level security;

create policy support_cases_select_permitted
  on public.support_cases for select to authenticated
  using (private.has_account_access(ml_account_id));

create policy support_messages_select_permitted
  on public.support_messages for select to authenticated
  using (private.has_account_access(ml_account_id));

create policy support_case_links_select_permitted
  on public.support_case_links for select to authenticated
  using (private.has_account_access(ml_account_id));

create policy support_case_deadlines_select_permitted
  on public.support_case_deadlines for select to authenticated
  using (private.has_account_access(ml_account_id));

create policy support_attachments_select_permitted
  on public.support_attachments for select to authenticated
  using (private.has_account_access(ml_account_id));

create policy support_case_events_select_permitted
  on public.support_case_events for select to authenticated
  using (private.has_account_access(ml_account_id));

-- ============================================================
-- 8. GRANTs explícitos — Supabase 2026 não expõe tabela nova por default
-- ============================================================

revoke all on
  public.support_cases,
  public.support_messages,
  public.support_case_links,
  public.support_case_deadlines,
  public.support_attachments,
  public.support_case_events
from anon, authenticated, service_role;

grant select on
  public.support_cases,
  public.support_messages,
  public.support_case_links,
  public.support_case_deadlines,
  public.support_attachments,
  public.support_case_events
to authenticated;

grant select, insert, update, delete on
  public.support_cases,
  public.support_messages,
  public.support_case_links,
  public.support_case_deadlines,
  public.support_attachments
to service_role;

-- L2 acompanha o contrato append-only também no privilégio.
grant select, insert on public.support_case_events to service_role;
