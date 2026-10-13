-- ============================================================
-- D-427 -- o FINANCEIRO dos pedidos da Shopee (fatia 3 da trilha, D-425).
--
-- Contrato conferido em 13/10/2026 (`docs/SHOPEE.md`):
-- `v2.payment.get_escrow_detail`, um pedido por chamada. `order_income`
-- traz o que a loja recebe (`escrow_amount`), as taxas da Shopee, o frete e
-- os descontos -- e MUDA ate o pedido completar.
--
-- Colunas para o que a V3 usa; o `order_income` inteiro guardado ao lado,
-- porque a Shopee acrescenta componente todo mes (a referencia registra
-- 5 mudancas entre julho e setembro de 2026) e reler 90 dias de pedido para
-- um campo novo custaria uma chamada por pedido.
--
-- Nulo = a Shopee nao mandou (ou o pedido ainda nao foi lido), nunca zero.
-- `financials_synced_at` preenchido com `order_income` nulo = lido, e a
-- Shopee nao tinha o financeiro (pedido nao achado).
-- ============================================================

alter table public.shopee_orders
  add column if not exists escrow_amount numeric,
  add column if not exists buyer_total_amount numeric,
  add column if not exists commission_fee numeric,
  add column if not exists service_fee numeric,
  add column if not exists seller_transaction_fee numeric,
  add column if not exists net_commission_fee numeric,
  add column if not exists net_service_fee numeric,
  add column if not exists actual_shipping_fee numeric,
  add column if not exists buyer_paid_shipping_fee numeric,
  add column if not exists shopee_shipping_rebate numeric,
  add column if not exists final_shipping_fee numeric,
  add column if not exists reverse_shipping_fee numeric,
  add column if not exists seller_discount numeric,
  add column if not exists shopee_discount numeric,
  add column if not exists voucher_from_seller numeric,
  add column if not exists voucher_from_shopee numeric,
  add column if not exists order_ams_commission_fee numeric,
  add column if not exists seller_order_processing_fee numeric,
  add column if not exists total_adjustment_amount numeric,
  add column if not exists escrow_amount_after_adjustment numeric,
  add column if not exists return_order_sns text[],
  add column if not exists order_income jsonb,
  add column if not exists financials_synced_at timestamptz;

alter table public.shopee_orders
  add constraint shopee_orders_order_income_objeto
  check (order_income is null or jsonb_typeof(order_income) = 'object');

comment on column public.shopee_orders.escrow_amount is
  'O que a loja deve receber pelo pedido (get_escrow_detail, D-427). Muda ate o pedido completar; NULO = nao lido ou sem financeiro.';
comment on column public.shopee_orders.final_shipping_fee is
  'O frete que fica com a loja, como a Shopee calcula: pode ser negativo (custo) ou positivo (D-427).';
comment on column public.shopee_orders.order_income is
  'O order_income inteiro de get_escrow_detail, como veio (D-427) -- sem nada do comprador.';
comment on column public.shopee_orders.financials_synced_at is
  'Quando o financeiro foi lido (D-427). Preenchido com order_income NULO = a Shopee nao tinha o financeiro do pedido.';

-- ------------------------------------------------------------
-- Quais pedidos de UMA loja precisam do financeiro (lido pelo worker,
-- `shopee.order-financials.sync`): pagos e
--   - nunca lidos, ou
--   - alterados na Shopee depois da ultima leitura (status, devolucao), ou
--   - ainda abertos (nem COMPLETED nem CANCELLED) e lidos ha mais de 24 h:
--     o `escrow_amount` muda ate o pedido completar, as vezes sem mexer no
--     `update_time` do pedido.
-- A comparacao entre duas colunas nao cabe num filtro do PostgREST; por isso
-- a funcao.
-- ------------------------------------------------------------
create or replace function public.shopee_orders_financials_pending(p_shopee_shop_id uuid, p_limit integer default 100)
returns table (order_sn text)
language sql
stable
set search_path = ''
as $$
  select o.order_sn
  from public.shopee_orders o
  where o.shopee_shop_id = p_shopee_shop_id
    and o.paid_at is not null
    and (
      o.financials_synced_at is null
      or o.shopee_updated_at > o.financials_synced_at
      or (o.order_status not in ('COMPLETED', 'CANCELLED') and o.financials_synced_at < now() - interval '24 hours')
    )
  order by o.financials_synced_at nulls first, o.shopee_updated_at
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

comment on function public.shopee_orders_financials_pending(uuid, integer) is
  'Pedidos pagos de uma loja Shopee cujo financeiro precisa ser lido (D-427): nunca lidos primeiro. So o worker (service_role) chama.';

revoke all on function public.shopee_orders_financials_pending(uuid, integer) from public, anon, authenticated;
grant execute on function public.shopee_orders_financials_pending(uuid, integer) to service_role;
