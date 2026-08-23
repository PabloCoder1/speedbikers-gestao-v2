-- ============================================================
-- Pedidos de compra (Fase 4, docs/ROADMAP.md): fornecedores, ciclo do
-- pedido, itens e histórico por evento.
--
-- "Nacional versus importado" NÃO ganha coluna nova: `skus.origin_code`
-- (tabela fiscal padrão da NF-e) + `skus.is_imported` (derivado) já
-- cobrem isso desde a Fase 2 (`20260820170000_create_catalog.sql`) — mais
-- preciso que o enum NACIONAL/IMPORTADO conceituado antes de qualquer dado
-- real existir (`docs/DATABASE.md` desatualizado nesse ponto, corrigido
-- junto com esta migration). A tela de pedido de compra só EXIBE esse
-- dado, puxado do SKU.
--
-- Referência real: o banco da V2 tinha um schema maduro para isto (1
-- pedido real, fornecedor Navetec, 5 itens, 8 eventos — D-040), inspecionado
-- diretamente antes de desenhar esta migration, mesmo princípio de
-- "evidência medida" já usado em D-037/D-039/D-048/D-053. Não copiado ao
-- pé da letra: os campos de sugestão automática de compra
-- (`suggested_quantity_snapshot`, `avg_daily_sales_30_snapshot`, etc.) são
-- Fase 6 (Diagnóstico), fora de escopo aqui — o que se aproveita é a FORMA
-- (snapshot de SKU por texto, não FK obrigatória; histórico por evento
-- append-only; fornecedor como entidade própria, nunca inferido de brand).
--
-- Escopo DELIBERADAMENTE menor que o ciclo da V2 nesta primeira fatia:
-- recebimento é tudo-ou-nada (RECEIVED), não parcial — a V2 real nunca
-- chegou a exercitar recebimento no único pedido existente. Recebimento
-- parcial fica para quando o volume real de uso mostrar que vale a pena
-- (mesmo raciocínio já usado para adiar vínculo fornecedor→SKU reutilizável
-- em docs/NFE.md secao 3).
--
-- Exportação (Excel/PDF) fica de fora — D-034 exige os modelos de
-- referência do usuário antes de implementar, ainda não recebidos.
--
-- Geração de `stock_movements` (ENTRADA_TRANSITO/RECEBIMENTO_TRANSITO,
-- já aprovados no vocabulário fechado desde 20260821200000) também fica
-- de fora — schema e ciclo primeiro, código de aplicação depois, mesmo
-- padrão incremental já usado em todo o ledger nesta sessão. É o que
-- destrava TRANSITO quando vier.
-- ============================================================

-- ============================================================
-- 1. suppliers
-- ============================================================

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  name text not null check (char_length(btrim(name)) between 1 and 200),
  legal_name text,
  document text,

  contact_name text,
  email text,
  phone text,
  whatsapp text,
  website text,
  notes text,

  is_active boolean not null default true,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint suppliers_org_name_unique unique (organization_id, name)
);

comment on table public.suppliers is
  'Fornecedor como entidade própria (nunca inferido de brand). Mutação só via RPC (create_supplier/update_supplier).';

create trigger suppliers_set_updated_at
  before update on public.suppliers
  for each row execute function private.set_updated_at();

-- ============================================================
-- 2. purchase_orders
--
-- Ciclo: DRAFT -> APPROVED -> ORDERED -> RECEIVED, com CANCELLED
-- alcançável de qualquer estado não-terminal. `order_number` é sequencial
-- e legível por humano (não é o `id`, que fica só na URL).
-- ============================================================

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  order_number bigint generated always as identity,

  -- Nulo permitido: um rascunho pode nascer antes do fornecedor estar
  -- decidido (mesma forma da V2 real). `restrict`: fornecedor com pedido
  -- no histórico não pode desaparecer.
  supplier_id uuid references public.suppliers(id) on delete restrict,

  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'APPROVED', 'ORDERED', 'RECEIVED', 'CANCELLED')),

  destination_warehouse_name text,
  currency text not null default 'BRL' check (char_length(currency) = 3),
  notes text,

  expected_at timestamptz,

  approved_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null,
  ordered_at timestamptz,
  ordered_by uuid references public.profiles(id) on delete set null,
  received_at timestamptz,
  received_by uuid references public.profiles(id) on delete set null,
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id) on delete set null,
  cancel_reason text,

  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint purchase_orders_approved_coherent check ((status not in ('APPROVED','ORDERED','RECEIVED')) or approved_at is not null),
  constraint purchase_orders_ordered_coherent check ((status not in ('ORDERED','RECEIVED')) or ordered_at is not null),
  constraint purchase_orders_received_coherent check (status <> 'RECEIVED' or received_at is not null),
  constraint purchase_orders_cancelled_coherent check (status <> 'CANCELLED' or cancelled_at is not null)
);

comment on table public.purchase_orders is
  'Pedido de compra a fornecedor. Ciclo DRAFT->APPROVED->ORDERED->RECEIVED, CANCELLED de qualquer estado não-terminal. Mutação só via RPC.';

comment on column public.purchase_orders.order_number is
  'Sequencial legível por humano, distinto do id (uuid). Não é chave de negócio entre organizações — sequência única da tabela.';

create index purchase_orders_org_status_idx
  on public.purchase_orders (organization_id, status, created_at desc);

create trigger purchase_orders_set_updated_at
  before update on public.purchase_orders
  for each row execute function private.set_updated_at();

-- ============================================================
-- 3. purchase_order_items
--
-- `sku_id` nulo permitido, `sku_snapshot`/`title_snapshot` sempre
-- presentes — mesmo padrão já usado em `erp_stock_snapshots`/
-- `document_items`: um item de pedido para um produto ainda não
-- catalogado continua sendo informação, não é descartado.
-- ============================================================

create table public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,

  position integer not null check (position >= 0),

  sku_id uuid references public.skus(id) on delete set null,
  sku_snapshot text not null check (char_length(btrim(sku_snapshot)) between 1 and 120),
  title_snapshot text,

  quantity_ordered numeric(14, 3) not null check (quantity_ordered > 0),
  unit_cost numeric(14, 4) check (unit_cost is null or unit_cost >= 0),

  created_at timestamptz not null default now(),

  constraint purchase_order_items_unique_position unique (purchase_order_id, position)
);

comment on table public.purchase_order_items is
  'Item de um pedido de compra. sku_id nulo até vínculo — sku_snapshot/title_snapshot preservam o que foi pedido de qualquer forma.';

create index purchase_order_items_order_idx
  on public.purchase_order_items (purchase_order_id, position);

-- ============================================================
-- 4. purchase_order_events — L2, append-only
--
-- Mesmo mecanismo de domain_events/sync_runs/stock_movements: histórico
-- que nunca é reescrito, só cresce.
-- ============================================================

create table public.purchase_order_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,

  event_type text not null
    check (event_type in ('CREATED', 'UPDATED', 'APPROVED', 'ORDERED', 'RECEIVED', 'CANCELLED')),

  actor_user_id uuid references public.profiles(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,

  occurred_at timestamptz not null default now()
);

comment on table public.purchase_order_events is
  'Histórico append-only de um pedido de compra — uma linha por transição de estado.';

create index purchase_order_events_order_idx
  on public.purchase_order_events (purchase_order_id, occurred_at desc);

create or replace function public.purchase_order_events_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'purchase_order_events e append-only: % nao e permitido.', tg_op;
end;
$$;

create trigger purchase_order_events_no_update
  before update on public.purchase_order_events
  for each row execute function public.purchase_order_events_reject_mutation();

create trigger purchase_order_events_no_delete
  before delete on public.purchase_order_events
  for each row execute function public.purchase_order_events_reject_mutation();

-- ============================================================
-- 5. RPCs — único caminho de escrita (mesmo padrão de
--    resolve_link_candidate/link_document_item: autorização refeita
--    internamente, security definer ignora GRANT e RLS).
--
-- Papel mínimo ADMIN/GESTOR em todas — mesmo nível de erp-imports e
-- documents (NF-e): pedido de compra mexe com dinheiro e, no fim do
-- ciclo, com estoque.
-- ============================================================

create or replace function private.check_purchase_order_writer(p_organization_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not private.is_member_of(p_organization_id) or not private.has_role(array['ADMIN', 'GESTOR']) then
    raise exception 'sem permissao para operar pedidos de compra';
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 5.1 create_supplier
-- ------------------------------------------------------------

create or replace function public.create_supplier(
  p_organization_id uuid,
  p_name text,
  p_legal_name text default null,
  p_document text default null,
  p_contact_name text default null,
  p_email text default null,
  p_phone text default null,
  p_whatsapp text default null,
  p_website text default null,
  p_notes text default null
)
returns public.suppliers
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.suppliers;
begin
  perform private.check_purchase_order_writer(p_organization_id);

  insert into public.suppliers (
    organization_id, name, legal_name, document, contact_name, email, phone, whatsapp, website, notes, created_by
  ) values (
    p_organization_id, p_name, p_legal_name, p_document, p_contact_name, p_email, p_phone, p_whatsapp, p_website, p_notes,
    (select auth.uid())
  )
  returning * into result;

  return result;
end;
$$;

comment on function public.create_supplier is
  'Cadastra um fornecedor. Autorização (ADMIN/GESTOR) refeita internamente.';

-- ------------------------------------------------------------
-- 5.2 update_supplier
-- ------------------------------------------------------------

create or replace function public.update_supplier(
  p_id uuid,
  p_name text,
  p_legal_name text default null,
  p_document text default null,
  p_contact_name text default null,
  p_email text default null,
  p_phone text default null,
  p_whatsapp text default null,
  p_website text default null,
  p_notes text default null,
  p_is_active boolean default true
)
returns public.suppliers
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.suppliers;
  result public.suppliers;
begin
  select * into s from public.suppliers where id = p_id for update;

  if s.id is null then
    raise exception 'fornecedor % nao encontrado', p_id;
  end if;

  perform private.check_purchase_order_writer(s.organization_id);

  update public.suppliers set
    name = p_name,
    legal_name = p_legal_name,
    document = p_document,
    contact_name = p_contact_name,
    email = p_email,
    phone = p_phone,
    whatsapp = p_whatsapp,
    website = p_website,
    notes = p_notes,
    is_active = p_is_active
  where id = p_id
  returning * into result;

  return result;
end;
$$;

comment on function public.update_supplier is
  'Edita um fornecedor existente. Autorização (ADMIN/GESTOR) refeita internamente.';

-- ------------------------------------------------------------
-- 5.3 create_purchase_order
--
-- `p_items` é um array jsonb: [{ "skuId": uuid|null, "skuSnapshot": text,
-- "titleSnapshot": text|null, "quantityOrdered": numeric, "unitCost":
-- numeric|null }]. Pelo menos um item é exigido — um pedido sem item não
-- tem o que comprar.
-- ------------------------------------------------------------

create or replace function public.create_purchase_order(
  p_organization_id uuid,
  p_items jsonb,
  p_supplier_id uuid default null,
  p_destination_warehouse_name text default null,
  p_currency text default null,
  p_notes text default null,
  p_expected_at timestamptz default null
)
returns public.purchase_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.purchase_orders;
  item jsonb;
  item_count integer;
  pos integer := 0;
begin
  perform private.check_purchase_order_writer(p_organization_id);

  if p_supplier_id is not null then
    if (select organization_id from public.suppliers where id = p_supplier_id) is distinct from p_organization_id then
      raise exception 'fornecedor pertence a outra organizacao';
    end if;
  end if;

  select count(*) into item_count from jsonb_array_elements(coalesce(p_items, '[]'::jsonb));

  if item_count = 0 then
    raise exception 'pedido de compra precisa de ao menos um item';
  end if;

  insert into public.purchase_orders (
    organization_id, supplier_id, destination_warehouse_name, currency, notes, expected_at, created_by
  ) values (
    p_organization_id, p_supplier_id, p_destination_warehouse_name, coalesce(p_currency, 'BRL'), p_notes, p_expected_at,
    (select auth.uid())
  )
  returning * into result;

  for item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.purchase_order_items (
      organization_id, purchase_order_id, position, sku_id, sku_snapshot, title_snapshot, quantity_ordered, unit_cost
    ) values (
      p_organization_id,
      result.id,
      pos,
      nullif(item->>'skuId', '')::uuid,
      item->>'skuSnapshot',
      item->>'titleSnapshot',
      (item->>'quantityOrdered')::numeric,
      nullif(item->>'unitCost', '')::numeric
    );

    pos := pos + 1;
  end loop;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (p_organization_id, result.id, 'CREATED', (select auth.uid()), jsonb_build_object('itemCount', item_count));

  return result;
end;
$$;

comment on function public.create_purchase_order is
  'Cria um pedido de compra em DRAFT com seus itens, na mesma transação. Autorização (ADMIN/GESTOR) refeita internamente.';

-- ------------------------------------------------------------
-- 5.4 update_purchase_order_draft
--
-- Só permitido em DRAFT — depois de aprovado, o pedido é um compromisso;
-- corrigi-lo é CANCELLED + novo pedido, não edição silenciosa do que já
-- foi aprovado.
-- ------------------------------------------------------------

create or replace function public.update_purchase_order_draft(
  p_id uuid,
  p_items jsonb,
  p_supplier_id uuid default null,
  p_destination_warehouse_name text default null,
  p_currency text default null,
  p_notes text default null,
  p_expected_at timestamptz default null
)
returns public.purchase_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  po public.purchase_orders;
  result public.purchase_orders;
  item jsonb;
  item_count integer;
  pos integer := 0;
begin
  select * into po from public.purchase_orders where id = p_id for update;

  if po.id is null then
    raise exception 'pedido de compra % nao encontrado', p_id;
  end if;

  perform private.check_purchase_order_writer(po.organization_id);

  if po.status <> 'DRAFT' then
    raise exception 'pedido % nao esta em rascunho (status %)', po.id, po.status;
  end if;

  if p_supplier_id is not null then
    if (select organization_id from public.suppliers where id = p_supplier_id) is distinct from po.organization_id then
      raise exception 'fornecedor pertence a outra organizacao';
    end if;
  end if;

  select count(*) into item_count from jsonb_array_elements(coalesce(p_items, '[]'::jsonb));

  if item_count = 0 then
    raise exception 'pedido de compra precisa de ao menos um item';
  end if;

  update public.purchase_orders set
    supplier_id = p_supplier_id,
    destination_warehouse_name = p_destination_warehouse_name,
    currency = coalesce(p_currency, 'BRL'),
    notes = p_notes,
    expected_at = p_expected_at
  where id = p_id
  returning * into result;

  delete from public.purchase_order_items where purchase_order_id = p_id;

  for item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.purchase_order_items (
      organization_id, purchase_order_id, position, sku_id, sku_snapshot, title_snapshot, quantity_ordered, unit_cost
    ) values (
      po.organization_id,
      p_id,
      pos,
      nullif(item->>'skuId', '')::uuid,
      item->>'skuSnapshot',
      item->>'titleSnapshot',
      (item->>'quantityOrdered')::numeric,
      nullif(item->>'unitCost', '')::numeric
    );

    pos := pos + 1;
  end loop;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (po.organization_id, p_id, 'UPDATED', (select auth.uid()), jsonb_build_object('itemCount', item_count));

  return result;
end;
$$;

comment on function public.update_purchase_order_draft is
  'Substitui campos e itens de um pedido em DRAFT, na mesma transação. Fora de DRAFT, recusa.';

-- ------------------------------------------------------------
-- 5.5 approve_purchase_order
-- ------------------------------------------------------------

create or replace function public.approve_purchase_order(p_id uuid)
returns public.purchase_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  po public.purchase_orders;
  result public.purchase_orders;
begin
  select * into po from public.purchase_orders where id = p_id for update;

  if po.id is null then
    raise exception 'pedido de compra % nao encontrado', p_id;
  end if;

  perform private.check_purchase_order_writer(po.organization_id);

  if po.status <> 'DRAFT' then
    raise exception 'pedido % nao esta em rascunho (status %)', po.id, po.status;
  end if;

  update public.purchase_orders
    set status = 'APPROVED', approved_at = now(), approved_by = (select auth.uid())
    where id = p_id
    returning * into result;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id)
  values (po.organization_id, p_id, 'APPROVED', (select auth.uid()));

  return result;
end;
$$;

comment on function public.approve_purchase_order is
  'DRAFT -> APPROVED. Autorização (ADMIN/GESTOR) refeita internamente.';

-- ------------------------------------------------------------
-- 5.6 mark_purchase_order_ordered
-- ------------------------------------------------------------

create or replace function public.mark_purchase_order_ordered(p_id uuid, p_expected_at timestamptz default null)
returns public.purchase_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  po public.purchase_orders;
  result public.purchase_orders;
begin
  select * into po from public.purchase_orders where id = p_id for update;

  if po.id is null then
    raise exception 'pedido de compra % nao encontrado', p_id;
  end if;

  perform private.check_purchase_order_writer(po.organization_id);

  if po.status <> 'APPROVED' then
    raise exception 'pedido % nao esta aprovado (status %)', po.id, po.status;
  end if;

  update public.purchase_orders set
    status = 'ORDERED',
    ordered_at = now(),
    ordered_by = (select auth.uid()),
    expected_at = coalesce(p_expected_at, expected_at)
  where id = p_id
  returning * into result;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (
    po.organization_id, p_id, 'ORDERED', (select auth.uid()),
    case when p_expected_at is not null then jsonb_build_object('expectedAt', p_expected_at) else '{}'::jsonb end
  );

  return result;
end;
$$;

comment on function public.mark_purchase_order_ordered is
  'APPROVED -> ORDERED. Autorização (ADMIN/GESTOR) refeita internamente.';

-- ------------------------------------------------------------
-- 5.7 receive_purchase_order
--
-- Tudo-ou-nada nesta primeira fatia (ver comentário no topo da migration).
-- ------------------------------------------------------------

create or replace function public.receive_purchase_order(p_id uuid)
returns public.purchase_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  po public.purchase_orders;
  result public.purchase_orders;
begin
  select * into po from public.purchase_orders where id = p_id for update;

  if po.id is null then
    raise exception 'pedido de compra % nao encontrado', p_id;
  end if;

  perform private.check_purchase_order_writer(po.organization_id);

  if po.status <> 'ORDERED' then
    raise exception 'pedido % nao esta em transito (status %)', po.id, po.status;
  end if;

  update public.purchase_orders
    set status = 'RECEIVED', received_at = now(), received_by = (select auth.uid())
    where id = p_id
    returning * into result;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id)
  values (po.organization_id, p_id, 'RECEIVED', (select auth.uid()));

  return result;
end;
$$;

comment on function public.receive_purchase_order is
  'ORDERED -> RECEIVED, recebimento total (não parcial nesta etapa). Autorização (ADMIN/GESTOR) refeita internamente.';

-- ------------------------------------------------------------
-- 5.8 cancel_purchase_order
-- ------------------------------------------------------------

create or replace function public.cancel_purchase_order(p_id uuid, p_reason text default null)
returns public.purchase_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  po public.purchase_orders;
  result public.purchase_orders;
begin
  select * into po from public.purchase_orders where id = p_id for update;

  if po.id is null then
    raise exception 'pedido de compra % nao encontrado', p_id;
  end if;

  perform private.check_purchase_order_writer(po.organization_id);

  if po.status in ('RECEIVED', 'CANCELLED') then
    raise exception 'pedido % ja esta em estado terminal (status %)', po.id, po.status;
  end if;

  update public.purchase_orders set
    status = 'CANCELLED',
    cancelled_at = now(),
    cancelled_by = (select auth.uid()),
    cancel_reason = p_reason
  where id = p_id
  returning * into result;

  insert into public.purchase_order_events (organization_id, purchase_order_id, event_type, actor_user_id, metadata)
  values (
    po.organization_id, p_id, 'CANCELLED', (select auth.uid()),
    case when p_reason is not null then jsonb_build_object('reason', p_reason) else '{}'::jsonb end
  );

  return result;
end;
$$;

comment on function public.cancel_purchase_order is
  'Qualquer estado não-terminal -> CANCELLED. Autorização (ADMIN/GESTOR) refeita internamente.';

-- ============================================================
-- 6. RLS
-- ============================================================

alter table public.suppliers enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.purchase_order_events enable row level security;

create policy suppliers_select_permitted
  on public.suppliers for select to authenticated
  using (private.is_member_of(organization_id) and private.has_role(array['ADMIN', 'GESTOR']));

create policy purchase_orders_select_permitted
  on public.purchase_orders for select to authenticated
  using (private.is_member_of(organization_id) and private.has_role(array['ADMIN', 'GESTOR']));

create policy purchase_order_items_select_permitted
  on public.purchase_order_items for select to authenticated
  using (private.is_member_of(organization_id) and private.has_role(array['ADMIN', 'GESTOR']));

create policy purchase_order_events_select_permitted
  on public.purchase_order_events for select to authenticated
  using (private.is_member_of(organization_id) and private.has_role(array['ADMIN', 'GESTOR']));

-- ============================================================
-- 7. GRANTs
--
-- Escrita nunca pela Data API — só pelas RPCs acima (usuário) ou
-- service_role (nenhum caso de uso hoje, mas consistente com o resto).
-- ============================================================

grant select on public.suppliers, public.purchase_orders, public.purchase_order_items, public.purchase_order_events
  to authenticated;

grant select, insert, update, delete
  on public.suppliers, public.purchase_orders, public.purchase_order_items, public.purchase_order_events
  to service_role;

revoke all on public.suppliers, public.purchase_orders, public.purchase_order_items, public.purchase_order_events
  from anon;

revoke all on function
  public.create_supplier(uuid, text, text, text, text, text, text, text, text, text),
  public.update_supplier(uuid, text, text, text, text, text, text, text, text, text, boolean),
  public.create_purchase_order(uuid, jsonb, uuid, text, text, text, timestamptz),
  public.update_purchase_order_draft(uuid, jsonb, uuid, text, text, text, timestamptz),
  public.approve_purchase_order(uuid),
  public.mark_purchase_order_ordered(uuid, timestamptz),
  public.receive_purchase_order(uuid),
  public.cancel_purchase_order(uuid, text)
  from public, anon;

grant execute on function
  public.create_supplier(uuid, text, text, text, text, text, text, text, text, text),
  public.update_supplier(uuid, text, text, text, text, text, text, text, text, text, boolean),
  public.create_purchase_order(uuid, jsonb, uuid, text, text, text, timestamptz),
  public.update_purchase_order_draft(uuid, jsonb, uuid, text, text, text, timestamptz),
  public.approve_purchase_order(uuid),
  public.mark_purchase_order_ordered(uuid, timestamptz),
  public.receive_purchase_order(uuid),
  public.cancel_purchase_order(uuid, text)
  to authenticated;
