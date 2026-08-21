-- ============================================================
-- orders / order_items — persistencia estruturada de pedidos (Fase 3).
--
-- L1 (operacional, mutavel) — docs/ARCHITECTURE.md secao 9. Pedidos MUDAM
-- de status ao longo do tempo (pago -> cancelado), diferente de sync_runs
-- (L2, append-only). O motor de diff/domain_events (proximo item do
-- checklist) e quem decide o que vira evento; esta migration so guarda o
-- estado atual.
--
-- `id` e o proprio id numerico do Mercado Livre, nao um uuid surrogate: e um
-- identificador global, estavel e imutavel de um sistema externo — criar um
-- segundo id so para ter uuid seria duplicar identidade sem motivo.
--
-- Fato medido na V2 que define o modelo (docs/DATABASE.md, docs/METRICS.md):
-- o Mercado Livre NAO entrega pedido multi-linha. `orders` e `order_items`
-- tinham exatamente 328.211 linhas cada — uma compra de varios itens vira
-- VARIOS pedidos ligados por `pack_id`. Por isso `total_amount` e ancora de
-- receita direta, sem rateio (divergencia medida contra `sum(unit_price *
-- quantity)`: exatamente zero em R$ 5,8 milhoes e 52 mil pedidos).
-- ============================================================

-- ============================================================
-- 1. orders
-- ============================================================

create table public.orders (
  id bigint primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- `restrict`, nao `cascade`: mesmo motivo de sync_runs.ml_account_id —
  -- historico de vendas nao pode desaparecer atras de uma exclusao de conta.
  ml_account_id uuid not null references public.ml_accounts(id) on delete restrict,

  -- NULL quando o pedido nao faz parte de um pack. `docs/METRICS.md`:
  -- pack_id e a unidade de compra real do cliente, precisa ser coluna de
  -- primeira classe para a metrica `pedidos_por_pack`.
  pack_id bigint,

  -- Vocabulario CONFIRMADO na documentacao oficial (mesma pagina do filtro,
  -- secao "Status da order", 2026-08-21) — os 9 valores existem hoje.
  status text not null
    check (status in (
      'confirmed', 'payment_required', 'payment_in_process', 'partially_paid',
      'paid', 'partially_refunded', 'pending_cancel', 'cancelled', 'invalid'
    )),
  status_detail text,

  date_created timestamptz not null,
  date_closed timestamptz,

  -- D-048: `date_last_updated` (bate o nome com o filtro `order.date_last_
  -- updated.from/to`) e o campo de checkpoint. `last_updated` e gravado à
  -- parte, sem uso de checkpoint, ate a diferenca entre os dois ficar clara
  -- — o exemplo oficial mostra os dois na MESMA order com valores diferentes.
  date_last_updated timestamptz not null,
  last_updated timestamptz,

  total_amount numeric not null check (total_amount >= 0),
  paid_amount numeric check (paid_amount is null or paid_amount >= 0),
  currency_id text not null,

  buyer_id bigint,
  tags text[] not null default '{}',

  -- `cancel_detail.description` quando presente. So o resumo — o motor de
  -- diff/domain_events (proximo item) e quem decide o que vira evento.
  cancel_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.orders is
  'Pedido do Mercado Livre, por id nativo. L1 operacional — muda de status ao longo do tempo.';

comment on column public.orders.pack_id is
  'Unidade de compra real do cliente (docs/METRICS.md). NULL quando o pedido nao faz parte de um pack.';

comment on column public.orders.date_last_updated is
  'Campo de checkpoint (D-048) — usa o nome que bate com o filtro order.date_last_updated.';

create index orders_account_freshness_idx
  on public.orders (ml_account_id, date_last_updated desc);

create index orders_pack_idx
  on public.orders (organization_id, pack_id)
  where pack_id is not null;

create index orders_date_created_idx
  on public.orders (organization_id, date_created);

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function private.set_updated_at();

-- ============================================================
-- 2. order_items
--
-- Sem id proprio do Mercado Livre por linha — `order_items` no payload e um
-- array sem identificador estavel. Reprocessar um pedido faz DELETE de
-- todas as linhas e INSERT de novo, mesmo padrao ja usado em
-- `erp_import_rows` (`apps/worker/src/handlers/erp-import-parse.ts`).
-- `position` (indice no array) sustenta a unicidade nesse esquema.
-- ============================================================

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id bigint not null references public.orders(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- Denormalizado de `orders.ml_account_id` de proposito: RLS direta sem
  -- join, mesmo padrao de `sync_errors.ml_account_id` (docs/DATABASE.md).
  ml_account_id uuid not null references public.ml_accounts(id) on delete restrict,

  position smallint not null check (position >= 0),

  item_id text not null check (item_id ~ '^MLB[0-9]+$'),
  variation_id text check (variation_id ~ '^[0-9]+$'),
  title text not null,
  seller_sku text,

  quantity integer not null check (quantity > 0),
  unit_price numeric not null check (unit_price >= 0),
  sale_fee numeric,
  currency_id text not null,

  -- D-020: resolvido e CONGELADO na persistencia — revincular um MLB amanha
  -- nao reescreve o faturamento ja gravado. `restrict`: um SKU com vendas
  -- registradas nao pode ser apagado silenciosamente.
  sku_id uuid references public.skus(id) on delete restrict,

  -- Qual vinculo foi usado para resolver o sku_id acima. `set null`: perder
  -- a referencia do vinculo nao apaga o item historico, so o rastro de COMO
  -- foi resolvido.
  sku_listing_link_id uuid references public.sku_listing_links(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (order_id, position)
);

comment on table public.order_items is
  'Linha de item de um pedido. Sem id proprio do Mercado Livre — reprocessar um pedido substitui todas as linhas (delete + insert).';

comment on column public.order_items.sku_id is
  'Resolvido e congelado no momento da persistencia (D-020) — nunca recalculado por join.';

create index order_items_sku_idx
  on public.order_items (sku_id)
  where sku_id is not null;

create index order_items_listing_idx
  on public.order_items (ml_account_id, item_id, variation_id);

create trigger order_items_set_updated_at
  before update on public.order_items
  for each row execute function private.set_updated_at();

-- ============================================================
-- 3. RLS
--
-- So leitura para authenticated: pedido e sincronizado do Mercado Livre,
-- nenhum humano edita diretamente (diferente de sku_listing_links, que tem
-- a Central de Vinculacoes). Escrita e so do worker, via service_role.
-- ============================================================

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

create policy orders_select_permitted
  on public.orders for select to authenticated
  using (private.has_account_access(ml_account_id));

create policy order_items_select_permitted
  on public.order_items for select to authenticated
  using (private.has_account_access(ml_account_id));

-- ============================================================
-- 4. GRANTs
-- ============================================================

grant select on public.orders, public.order_items to authenticated;

grant select, insert, update, delete on public.orders, public.order_items to service_role;

revoke all on public.orders from anon;
revoke all on public.order_items from anon;
