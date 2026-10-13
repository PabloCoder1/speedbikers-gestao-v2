-- ============================================================
-- D-426 -- os PEDIDOS da Shopee (fatia 2 da trilha, D-425).
--
-- Contrato conferido em 13/10/2026 (`docs/SHOPEE.md`): `get_order_list` por
-- janela de `update_time` (ate 15 dias, 100 por pagina, cursor) e
-- `get_order_detail` (ate 50 por chamada, itens e valores so quando pedidos).
--
-- Grao proprio, como as lojas (D-425 secao 1): o pedido da Shopee e
-- identificado por `order_sn` (texto), nao pelo `bigint` do Mercado Livre, e
-- nao entra no ledger de estoque -- a baixa e a fatia 5, com decisao do dono.
--
-- Nada do comprador: nome, telefone e endereco vem mascarados sem acesso a
-- Sensitive Data, e a V3 nem os pede.
-- ============================================================

create table public.shopee_orders (
  shopee_shop_id uuid not null references public.shopee_shops (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  order_sn text not null check (length(order_sn) between 1 and 64),
  -- UNPAID, READY_TO_SHIP, PROCESSED, SHIPPED, COMPLETED, IN_CANCEL,
  -- CANCELLED, INVOICE_PENDING... como veio: a lista da Shopee cresce.
  order_status text not null,
  currency text,
  cod boolean,
  -- Pago pelo comprador (itens + frete dele - promocoes da Shopee); NULO antes
  -- do pagamento, nunca zero.
  total_amount numeric,
  shopee_created_at timestamptz not null,
  shopee_updated_at timestamptz not null,
  paid_at timestamptz,
  shipping_carrier text,
  payment_method text,
  cancel_by text,
  cancel_reason text,
  synced_at timestamptz not null default now(),
  primary key (shopee_shop_id, order_sn)
);

create index shopee_orders_org_created_idx on public.shopee_orders (organization_id, shopee_created_at desc);

comment on table public.shopee_orders is
  'Pedidos da Shopee por loja (D-426), espelho de get_order_detail. Escritos so pelo worker; total_amount NULO antes do pagamento.';

create table public.shopee_order_items (
  shopee_shop_id uuid not null,
  order_sn text not null,
  -- A ordem do item no pedido: o detalhe nao traz identificador estavel por
  -- linha em todo caso (bundle), e a linha e substituida a cada sincronizacao.
  position smallint not null check (position >= 0),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  item_id bigint not null,
  item_name text,
  -- SKU do vendedor: o caminho do vinculo com o SKU da V3 (fatia 4).
  item_sku text,
  model_id bigint,
  model_name text,
  model_sku text,
  quantity integer not null check (quantity >= 0),
  original_price numeric,
  -- 0 em item de bundle deal (documentacao): o preco do item fica com o
  -- financeiro (fatia 3).
  discounted_price numeric,
  promotion_type text,
  primary key (shopee_shop_id, order_sn, position),
  foreign key (shopee_shop_id, order_sn) references public.shopee_orders (shopee_shop_id, order_sn) on delete cascade
);

comment on table public.shopee_order_items is
  'Itens dos pedidos da Shopee (D-426), substituidos a cada sincronizacao do pedido. item_sku/model_sku sao o SKU do vendedor.';

-- O marco da sincronizacao: ate onde, em `update_time`, os pedidos da loja ja
-- foram lidos. NULO = nunca; a primeira corrida comeca 90 dias atras.
alter table public.shopee_shops add column if not exists orders_synced_until timestamptz;

comment on column public.shopee_shops.orders_synced_until is
  'Ate onde (update_time da Shopee) os pedidos da loja ja foram lidos (D-426). NULO = nunca; a primeira leitura comeca 90 dias atras.';

-- ------------------------------------------------------------
-- RLS: membros da organizacao leem; so o worker escreve.
-- ------------------------------------------------------------
alter table public.shopee_orders enable row level security;
alter table public.shopee_order_items enable row level security;

create policy shopee_orders_select_member
  on public.shopee_orders for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy shopee_order_items_select_member
  on public.shopee_order_items for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

revoke all on public.shopee_orders from anon, authenticated;
revoke all on public.shopee_order_items from anon, authenticated;
grant select on public.shopee_orders to authenticated;
grant select on public.shopee_order_items to authenticated;
grant all on public.shopee_orders to service_role;
grant all on public.shopee_order_items to service_role;
