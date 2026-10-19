-- D-495 (a) — Quem expede o pedido da Shopee: o armazém dela ou o vendedor.
--
-- O dono confirmou (19/10/2026) que algumas vendas da Shopee saem do armazém da
-- própria Shopee -- o equivalente ao Full do Mercado Livre (D-352): a venda
-- desse pedido não pode baixar o estoque da loja. A documentação oficial de
-- `v2.order.get_order_detail` (lida em 19/10) tem o campo, pedido em
-- `response_optional_fields`:
--   `fulfillment_flag` -- "Use this field to indicate the order is fulfilled
--   by shopee or seller. Applicable values: fulfilled_by_shopee,
--   fulfilled_by_cb_seller, fulfilled_by_local_seller."
--
-- Esta migration só GUARDA o campo, como veio (texto, sem lista fechada: valor
-- novo da Shopee não derruba a leitura). A baixa da venda da Shopee (D-495 b)
-- só usa o sinal depois de ele ser conferido nos pedidos reais.
--
-- Compatível nas duas ordens de deploy: `jsonb_to_recordset` ignora a chave a
-- mais do worker novo com a função de antes; e a leitura do worker de antes,
-- sem o campo, não apaga o valor guardado.

alter table public.shopee_orders
  add column fulfillment_flag text
    check (fulfillment_flag is null or char_length(fulfillment_flag) between 1 and 40);

comment on column public.shopee_orders.fulfillment_flag is
  'Quem expede o pedido, como a Shopee devolve em get_order_detail (D-495): fulfilled_by_shopee (o armazem da Shopee, o equivalente ao Full), fulfilled_by_cb_seller ou fulfilled_by_local_seller. NULL ate o pedido ser lido pelo worker da D-495.';

-- A gravação do lote (D-432) com o campo novo; o resto, igual.
create or replace function public.shopee_upsert_orders(
  p_shopee_shop_id uuid,
  p_pedidos jsonb,
  p_synced_at timestamptz default now()
) returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_org uuid;
  v_gravados text[];
begin
  select organization_id into v_org from public.shopee_shops where id = p_shopee_shop_id;

  if v_org is null then
    raise exception 'loja shopee % nao encontrada', p_shopee_shop_id;
  end if;

  if p_pedidos is null or jsonb_typeof(p_pedidos) <> 'array' then
    raise exception 'p_pedidos precisa ser um array';
  end if;

  with entrada as (
    -- O mesmo pedido duas vezes no lote: vale a leitura mais nova.
    select distinct on (e.order_sn) e.*
    from jsonb_to_recordset(p_pedidos) as e (
      order_sn text,
      order_status text,
      currency text,
      cod boolean,
      total_amount numeric,
      shopee_created_at timestamptz,
      shopee_updated_at timestamptz,
      paid_at timestamptz,
      shipping_carrier text,
      payment_method text,
      cancel_by text,
      cancel_reason text,
      fulfillment_flag text
    )
    order by e.order_sn, e.shopee_updated_at desc
  ),
  gravados as (
    insert into public.shopee_orders as o (
      shopee_shop_id, organization_id, order_sn, order_status, currency, cod, total_amount,
      shopee_created_at, shopee_updated_at, paid_at, shipping_carrier, payment_method,
      cancel_by, cancel_reason, fulfillment_flag, synced_at
    )
    select
      p_shopee_shop_id, v_org, e.order_sn, e.order_status, e.currency, e.cod, e.total_amount,
      e.shopee_created_at, e.shopee_updated_at, e.paid_at, e.shipping_carrier, e.payment_method,
      e.cancel_by, e.cancel_reason, nullif(btrim(e.fulfillment_flag), ''), p_synced_at
    from entrada e
    on conflict (shopee_shop_id, order_sn) do update set
      order_status = excluded.order_status,
      currency = excluded.currency,
      cod = excluded.cod,
      total_amount = excluded.total_amount,
      shopee_created_at = excluded.shopee_created_at,
      shopee_updated_at = excluded.shopee_updated_at,
      paid_at = excluded.paid_at,
      shipping_carrier = excluded.shipping_carrier,
      payment_method = excluded.payment_method,
      cancel_by = excluded.cancel_by,
      cancel_reason = excluded.cancel_reason,
      -- Leitura sem o campo (o worker de antes da D-495) nao apaga o que ja
      -- se sabe de quem expede o pedido.
      fulfillment_flag = coalesce(excluded.fulfillment_flag, o.fulfillment_flag),
      synced_at = excluded.synced_at
    -- NAO REGRIDE: a leitura mais velha que a guardada nao sobrescreve.
    where o.shopee_updated_at <= excluded.shopee_updated_at
    returning o.order_sn
  )
  select coalesce(array_agg(g.order_sn), '{}') into v_gravados from gravados g;

  if cardinality(v_gravados) = 0 then
    return 0;
  end if;

  delete from public.shopee_order_items
   where shopee_shop_id = p_shopee_shop_id
     and order_sn = any (v_gravados);

  insert into public.shopee_order_items (
    shopee_shop_id, order_sn, position, organization_id, item_id, item_name, item_sku,
    model_id, model_name, model_sku, quantity, original_price, discounted_price, promotion_type
  )
  select
    p_shopee_shop_id, p.pedido ->> 'order_sn', i.position, v_org, i.item_id, i.item_name, i.item_sku,
    i.model_id, i.model_name, i.model_sku, i.quantity, i.original_price, i.discounted_price, i.promotion_type
  from (
    -- Um pedido repetido no lote entra uma vez, com os itens da leitura mais nova.
    select distinct on (el ->> 'order_sn') el as pedido
    from jsonb_array_elements(p_pedidos) el
    order by el ->> 'order_sn', (el ->> 'shopee_updated_at')::timestamptz desc
  ) p
  cross join lateral jsonb_to_recordset(coalesce(p.pedido -> 'itens', '[]'::jsonb)) as i (
    position smallint,
    item_id bigint,
    item_name text,
    item_sku text,
    model_id bigint,
    model_name text,
    model_sku text,
    quantity integer,
    original_price numeric,
    discounted_price numeric,
    promotion_type text
  )
  where p.pedido ->> 'order_sn' = any (v_gravados);

  -- D-430: o SKU de cada item, na mesma transacao.
  perform public.shopee_resolve_order_item_skus(p_shopee_shop_id, v_gravados);

  return cardinality(v_gravados);
end;
$$;
