-- ============================================================
-- Custos financeiros por pedido (D-165) — a fatia de ingestão que destrava
-- a margem operacional (docs/METRICS.md 5C.2, "bloqueada até frete e
-- desconto serem persistidos").
--
-- Fontes confirmadas em §2.15 (leitura oficial, D-120):
--   frete do vendedor  = senders[].cost   em GET /shipments/{id}/costs
--   desconto do vendedor = amounts.seller em GET /orders/{id}/discounts
--
-- `orders.shipping_id` passa a ser persistido (o payload do pedido já o
-- traz — zero chamadas novas); a captura dos custos é um job de varredura
-- por conta, com espaçamento (lição D-156). SEM backfill além da janela da
-- varredura: como sku_cost_history (D-149), o rastreio começa quando a
-- captura começa, e a tela declara a cobertura.
--
-- NULL nunca significa zero: custo/desconto não observado fica NULL —
-- afirmar R$ 0,00 sobre o que não foi lido seria a mentira que o catálogo
-- de métricas proíbe.
-- ============================================================

alter table public.orders
  add column shipping_id bigint;

comment on column public.orders.shipping_id is
  'shipping.id do payload do pedido (D-165) — a chave de GET /shipments/{id}/costs. Nulo em pedidos persistidos antes da captura ou sem envio.';

create table public.order_financials (
  order_id bigint primary key references public.orders(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ml_account_id uuid not null references public.ml_accounts(id) on delete restrict,

  -- Soma de senders[].cost — o custo do frete cobrado DO VENDEDOR (a FAQ
  -- oficial designa este campo para conciliação). NULL = não observado.
  seller_shipping_cost numeric check (seller_shipping_cost is null or seller_shipping_cost >= 0),
  -- amounts.seller — a parcela do desconto bancada pelo vendedor. A doc
  -- avisa que exclui taxas adicionais e reembolsos posteriores. NULL = não
  -- observado.
  seller_discount numeric check (seller_discount is null or seller_discount >= 0),

  captured_at timestamptz not null default now()
);

comment on table public.order_financials is
  'Custos por pedido capturados do Mercado Livre (D-165): frete do vendedor e desconto bancado. Uma linha por pedido varrido; campo NULL = não observado, nunca zero fingido. Base da margem_operacional_pedido (METRICS 5C.2) — que NÃO é receita líquida (5C.1).';

create index order_financials_account_idx
  on public.order_financials (ml_account_id, captured_at desc);

alter table public.order_financials enable row level security;

create policy order_financials_select_permitted
  on public.order_financials for select to authenticated
  using (private.has_account_access(ml_account_id));

revoke all on public.order_financials from anon, authenticated, service_role;
grant select on public.order_financials to authenticated;
grant select, insert on public.order_financials to service_role;

-- A varredura ganha observabilidade real (sync_runs) — quinto alargamento
-- deste CHECK, mesmo formato dos quatro anteriores.
alter table public.sync_runs drop constraint sync_runs_resource_check;
alter table public.sync_runs add constraint sync_runs_resource_check
  check (resource = any (array['orders', 'listings', 'fulfillment', 'visits', 'questions', 'messages', 'claims', 'order_financials']));

alter table public.sync_errors drop constraint sync_errors_resource_check;
alter table public.sync_errors add constraint sync_errors_resource_check
  check (resource = any (array['orders', 'listings', 'fulfillment', 'visits', 'questions', 'messages', 'claims', 'order_financials']));
