-- D-407 — Quem paga o frete: o subsídio do Mercado Livre e o frete do comprador.
--
-- `GET /shipments/{id}/costs` já é lido por pedido (D-165, D-396), só para
-- `senders[].cost`. A mesma resposta traz o resto da conta, e a forma foi
-- conferida em 12 envios reais de produção (24/09: Full, coleta e Flex, duas
-- contas):
--
--   gross_amount                      o frete cheio do envio, pela tabela
--   receiver.cost                     o que o comprador pagou de frete
--   receiver.discounts[].promoted_amount  o que o Mercado Livre bancou do
--                                     frete do comprador (tipos `loyal`,
--                                     `ratio`, `gap`)
--   senders[].cost                    o que o vendedor pagou (já gravado)
--   senders[].discounts[].promoted_amount o desconto do Mercado Livre no
--                                     frete do vendedor (tipo `mandatory`,
--                                     30% ou 50% nas amostras)
--
-- Nas 12, o frete cheio fecha exatamente com os quatro: comprador + desconto
-- do comprador + vendedor + desconto do vendedor. Pelo `promoted_amount`, e
-- não pelo `save`: em 2 das 12 o `save` do comprador veio menor que o
-- desconto e a soma não fecharia.
--
-- NULL = não observado, como nas colunas de D-165: pedido capturado antes
-- desta migration, 4xx do endpoint ou parte da resposta fora da forma. Zero
-- é observado (sem desconto nenhum, como no Flex, onde o vendedor não paga).

alter table public.order_financials
  add column shipping_list_cost numeric
    check (shipping_list_cost is null or shipping_list_cost >= 0),
  add column seller_shipping_subsidy numeric
    check (seller_shipping_subsidy is null or seller_shipping_subsidy >= 0),
  add column buyer_shipping_cost numeric
    check (buyer_shipping_cost is null or buyer_shipping_cost >= 0),
  add column buyer_shipping_subsidy numeric
    check (buyer_shipping_subsidy is null or buyer_shipping_subsidy >= 0);

comment on column public.order_financials.shipping_list_cost is
  'gross_amount de GET /shipments/{id}/costs (D-407): o frete cheio do envio pela tabela do Mercado Livre, antes de quem paga o quê. NULL = não observado.';
comment on column public.order_financials.seller_shipping_subsidy is
  'Soma de senders[].discounts[].promoted_amount (D-407): o desconto do Mercado Livre no frete do vendedor. seller_shipping_cost já é o valor depois dele. NULL = não observado; 0 = observado, sem desconto.';
comment on column public.order_financials.buyer_shipping_cost is
  'receiver.cost (D-407): o frete pago pelo comprador. NULL = não observado.';
comment on column public.order_financials.buyer_shipping_subsidy is
  'Soma de receiver.discounts[].promoted_amount (D-407): o frete do comprador bancado pelo Mercado Livre. NULL = não observado.';
