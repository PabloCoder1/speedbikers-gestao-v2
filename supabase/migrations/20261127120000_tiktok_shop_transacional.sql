-- ============================================================
-- D-838 -- M04 (TikTok Shop): camada transacional, trava atômica
-- de sincronização de pedidos e RLS multi-tenant.
--
-- Espelha o desenho da Shopee (D-425/D-426/D-481) sem armazenar
-- nenhum dado pessoal de comprador (`docs/TIKTOK_SHOP.md` §13):
-- - `tiktok_shops` ganha `orders_synced_until` e `orders_sync_locked_until`
--   + função `tiktok_orders_sync_lock(uuid, integer)` exclusiva de `service_role`;
-- - 6 tabelas transacionais com PK composta idempotente, índices por
--   `organization_id`, trigger `private.set_updated_at()` e RLS
--   somente leitura para `authenticated` (escrita exclusiva de `service_role`).
-- ============================================================

alter table public.tiktok_shops
  add column orders_synced_until timestamptz,
  add column orders_sync_locked_until timestamptz;

comment on column public.tiktok_shops.orders_synced_until is
  'Marco da última janela de pedidos sincronizada com sucesso para a loja TikTok Shop (D-838).';
comment on column public.tiktok_shops.orders_sync_locked_until is
  'Trava exclusiva de leitura de pedidos TikTok Shop (D-838): NULO = livre. Só o worker grava.';

create or replace function public.tiktok_orders_sync_lock(
  p_tiktok_shop_id uuid,
  p_ttl_seconds integer default 900
)
returns boolean
language sql
volatile
set search_path = ''
as $$
  with travada as (
    update public.tiktok_shops
       set orders_sync_locked_until = now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 900), 60))
     where id = p_tiktok_shop_id
       and (orders_sync_locked_until is null or orders_sync_locked_until < now())
    returning id
  )
  select exists (select 1 from travada);
$$;

comment on function public.tiktok_orders_sync_lock(uuid, integer) is
  'Trava atômica por loja para tiktok.orders.sync (D-838): true se adquirida. Exclusiva de service_role.';

revoke all on function public.tiktok_orders_sync_lock(uuid, integer) from public, anon, authenticated;
grant execute on function public.tiktok_orders_sync_lock(uuid, integer) to service_role;

-- ------------------------------------------------------------
-- 1. Pedidos (`tiktok_orders`) — sem PII de comprador
-- ------------------------------------------------------------
create table public.tiktok_orders (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  tiktok_shop_id uuid not null references public.tiktok_shops (id) on delete cascade,
  order_id text not null check (length(trim(order_id)) between 1 and 128),
  raw_status text not null,
  lifecycle text not null check (lifecycle in ('PENDENTE_PAGAMENTO', 'JANELA_ARREPENDIMENTO', 'VALIDA', 'CANCELADA', 'DESCONHECIDO')),
  fulfillment_channel text not null check (fulfillment_channel in ('LOCAL', 'FBT', 'DESCONHECIDO')),
  business_date date not null,
  created_at_remote timestamptz not null,
  updated_at_remote timestamptz not null,
  paid_at_remote timestamptz,
  currency text,
  sub_total_brl numeric(14, 2),
  shipping_fee_brl numeric(14, 2),
  total_amount_brl numeric(14, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tiktok_shop_id, order_id)
);

create index tiktok_orders_org_date_idx
  on public.tiktok_orders (organization_id, business_date desc);
create index tiktok_orders_org_status_idx
  on public.tiktok_orders (organization_id, lifecycle);

create trigger tiktok_orders_set_updated_at
  before update on public.tiktok_orders
  for each row execute function private.set_updated_at();

comment on table public.tiktok_orders is
  'Pedidos operacionais do TikTok Shop sem PII de comprador (D-838, M04). Upsert idempotente por (tiktok_shop_id, order_id).';

-- ------------------------------------------------------------
-- 2. Itens agregados do pedido (`tiktok_order_items`)
-- ------------------------------------------------------------
create table public.tiktok_order_items (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  tiktok_shop_id uuid not null,
  order_id text not null,
  position integer not null check (position >= 0),
  sku_id text,
  seller_sku text,
  product_id text,
  is_gift boolean not null default false,
  quantity integer not null check (quantity > 0),
  line_item_ids text[] not null default '{}',
  sale_price_total numeric(14, 2),
  original_price_total numeric(14, 2),
  seller_discount_total numeric(14, 2),
  platform_discount_total numeric(14, 2),
  combined_listing_skus jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tiktok_shop_id, order_id, position),
  foreign key (tiktok_shop_id, order_id)
    references public.tiktok_orders (tiktok_shop_id, order_id)
    on delete cascade
);

create index tiktok_order_items_org_seller_sku_idx
  on public.tiktok_order_items (organization_id, seller_sku);

create trigger tiktok_order_items_set_updated_at
  before update on public.tiktok_order_items
  for each row execute function private.set_updated_at();

comment on table public.tiktok_order_items is
  'Itens agregados por SKU/brinde dos pedidos TikTok Shop (D-838, M04).';

-- ------------------------------------------------------------
-- 3. Catálogo e estoque por unidade (`tiktok_catalog_units`)
-- ------------------------------------------------------------
create table public.tiktok_catalog_units (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  tiktok_shop_id uuid not null references public.tiktok_shops (id) on delete cascade,
  product_id text not null check (length(trim(product_id)) between 1 and 128),
  sku_key text not null check (length(trim(sku_key)) between 1 and 128),
  sku_id text,
  seller_sku text,
  seller_sku_key text,
  title text,
  raw_status text not null,
  lifecycle text not null check (lifecycle in ('ATIVO', 'PAUSADO', 'EXCLUIDO', 'RASCUNHO', 'DESCONHECIDO')),
  currency text,
  original_price_brl numeric(14, 2),
  sale_price_brl numeric(14, 2),
  available_stock integer check (available_stock is null or available_stock >= 0),
  committed_stock integer check (committed_stock is null or committed_stock >= 0),
  created_at_remote timestamptz,
  updated_at_remote timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tiktok_shop_id, product_id, sku_key)
);

create index tiktok_catalog_units_org_sku_key_idx
  on public.tiktok_catalog_units (organization_id, seller_sku_key);
create index tiktok_catalog_units_org_lifecycle_idx
  on public.tiktok_catalog_units (organization_id, lifecycle);

create trigger tiktok_catalog_units_set_updated_at
  before update on public.tiktok_catalog_units
  for each row execute function private.set_updated_at();

comment on table public.tiktok_catalog_units is
  'Unidades de catálogo/variação do TikTok Shop com ausência preservada como NULL (D-838, M04).';

-- ------------------------------------------------------------
-- 4. Devoluções (`tiktok_returns`)
-- ------------------------------------------------------------
create table public.tiktok_returns (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  tiktok_shop_id uuid not null references public.tiktok_shops (id) on delete cascade,
  return_id text not null check (length(trim(return_id)) between 1 and 128),
  order_id text not null check (length(trim(order_id)) between 1 and 128),
  normalized_status text not null,
  kind text not null check (kind in ('RETORNO_FISICO', 'APENAS_REEMBOLSO', 'CANCELAMENTO', 'DESCONHECIDO')),
  completed boolean not null default false,
  business_date date,
  currency text,
  refund_total_brl numeric(14, 2),
  refund_subtotal_brl numeric(14, 2),
  refund_shipping_brl numeric(14, 2),
  items jsonb not null default '[]'::jsonb,
  created_at_remote timestamptz,
  updated_at_remote timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tiktok_shop_id, return_id)
);

create index tiktok_returns_org_order_idx
  on public.tiktok_returns (organization_id, order_id);
create index tiktok_returns_org_date_idx
  on public.tiktok_returns (organization_id, business_date desc);

create trigger tiktok_returns_set_updated_at
  before update on public.tiktok_returns
  for each row execute function private.set_updated_at();

comment on table public.tiktok_returns is
  'Devoluções e reembolsos do TikTok Shop normalizados sem PII (D-838, M04).';

-- ------------------------------------------------------------
-- 5. Financeiro por pedido (`tiktok_order_financials`)
-- ------------------------------------------------------------
create table public.tiktok_order_financials (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  tiktok_shop_id uuid not null references public.tiktok_shops (id) on delete cascade,
  order_id text not null check (length(trim(order_id)) between 1 and 128),
  currency text,
  revenue_amount numeric(14, 2),
  settlement_amount numeric(14, 2),
  fee_and_tax_amount numeric(14, 2),
  shipping_cost_amount numeric(14, 2),
  sku_transactions jsonb not null default '[]'::jsonb,
  raw_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tiktok_shop_id, order_id)
);

create index tiktok_order_financials_org_updated_idx
  on public.tiktok_order_financials (organization_id, updated_at desc);

create trigger tiktok_order_financials_set_updated_at
  before update on public.tiktok_order_financials
  for each row execute function private.set_updated_at();

comment on table public.tiktok_order_financials is
  'Transações financeiras liquidadas por pedido no TikTok Shop (D-838, M04).';

-- ------------------------------------------------------------
-- 6. Extratos financeiros (`tiktok_statements`)
-- ------------------------------------------------------------
create table public.tiktok_statements (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  tiktok_shop_id uuid not null references public.tiktok_shops (id) on delete cascade,
  statement_id text not null check (length(trim(statement_id)) between 1 and 128),
  statement_time timestamptz,
  payment_status text,
  currency text,
  revenue_amount numeric(14, 2),
  settlement_amount numeric(14, 2),
  fee_amount numeric(14, 2),
  adjustment_amount numeric(14, 2),
  shipping_fee_amount numeric(14, 2),
  net_sales_amount numeric(14, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tiktok_shop_id, statement_id)
);

create index tiktok_statements_org_time_idx
  on public.tiktok_statements (organization_id, statement_time desc);

create trigger tiktok_statements_set_updated_at
  before update on public.tiktok_statements
  for each row execute function private.set_updated_at();

comment on table public.tiktok_statements is
  'Extratos periódicos de repasse do TikTok Shop (D-838, M04).';

-- ------------------------------------------------------------
-- RLS e grants (somente leitura para authenticated; escrita via service_role)
-- ------------------------------------------------------------
alter table public.tiktok_orders enable row level security;
alter table public.tiktok_order_items enable row level security;
alter table public.tiktok_catalog_units enable row level security;
alter table public.tiktok_returns enable row level security;
alter table public.tiktok_order_financials enable row level security;
alter table public.tiktok_statements enable row level security;

create policy tiktok_orders_select_member
  on public.tiktok_orders for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy tiktok_order_items_select_member
  on public.tiktok_order_items for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy tiktok_catalog_units_select_member
  on public.tiktok_catalog_units for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy tiktok_returns_select_member
  on public.tiktok_returns for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy tiktok_order_financials_select_member
  on public.tiktok_order_financials for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

create policy tiktok_statements_select_member
  on public.tiktok_statements for select to authenticated
  using (organization_id in (select private.accessible_orgs()));

revoke all on public.tiktok_orders, public.tiktok_order_items, public.tiktok_catalog_units,
  public.tiktok_returns, public.tiktok_order_financials, public.tiktok_statements
  from anon, authenticated;

grant select on public.tiktok_orders, public.tiktok_order_items, public.tiktok_catalog_units,
  public.tiktok_returns, public.tiktok_order_financials, public.tiktok_statements
  to authenticated;

grant all on public.tiktok_orders, public.tiktok_order_items, public.tiktok_catalog_units,
  public.tiktok_returns, public.tiktok_order_financials, public.tiktok_statements
  to service_role;

-- ------------------------------------------------------------
-- Recusa atômica de refresh do TikTok Shop (`tiktok_reject_token_refresh`)
-- Mesma ordem de lock de `tiktok_connect_shops` (`tiktok_shops` -> `tiktok_credentials`)
-- para fechar a corrida entre liberação da trava, reconexão OAuth e gravação de ERROR.
-- ------------------------------------------------------------
create or replace function public.tiktok_reject_token_refresh(
  p_tiktok_shop_id uuid,
  p_locked_until timestamptz,
  p_previous_refresh_ciphertext text,
  p_error text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1 from public.tiktok_shops where id = p_tiktok_shop_id for update;

  update public.tiktok_credentials
     set refresh_locked_until = null
   where tiktok_shop_id = p_tiktok_shop_id
     and refresh_locked_until = p_locked_until
     and refresh_token_ciphertext = p_previous_refresh_ciphertext;

  if not found then
    return false;
  end if;

  update public.tiktok_shops
     set status = 'ERROR', last_error = left(p_error, 2000)
   where id = p_tiktok_shop_id;

  return true;
end;
$$;

comment on function public.tiktok_reject_token_refresh(uuid, timestamptz, text, text) is
  'Recusa atômica de refresh TikTok Shop (D-838/M04): só marca ERROR se a trava e o refresh_token_ciphertext ainda forem os do chamador. Exclusiva de service_role.';

revoke all on function public.tiktok_reject_token_refresh(uuid, timestamptz, text, text)
  from public, anon, authenticated;
grant execute on function public.tiktok_reject_token_refresh(uuid, timestamptz, text, text)
  to service_role;
