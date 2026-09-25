-- D-362 (1ª parte) — O item vendido guarda o user product que o pedido traz.
--
-- Em 30 dias, 3.630 dos 27.751 itens vendidos (13%, 380 anúncios) ficaram
-- sem SKU: o anúncio não tem vínculo por item, e a V3 não sabia qual user
-- product ele vende -- os 3.588 vínculos USER_PRODUCT do UpSeller ficavam
-- parados. A sonda de 25/09 (8 pedidos sem SKU, quatro contas, só GET) mediu
-- que `GET /orders/{id}` traz `order_items[].item.user_product_id`, igual ao
-- da raiz do anúncio nos oito; em seis deles o user product tem vínculo.
--
-- Esta parte só GRAVA o identificador. Nenhuma venda muda de SKU e nenhum
-- estoque se move: a resolução pelo vínculo USER_PRODUCT é a 2ª parte.
-- O worker só escreve a forma `MLBU<dígitos>`; outra forma vira NULL lá,
-- para um pedido nunca deixar de gravar por causa dela.

alter table public.order_items
  add column user_product_id text;

comment on column public.order_items.user_product_id is
  'O user product (MLBU...) que o pedido traz em order_items[].item.user_product_id (D-362): o produto do catalogo do vendedor que foi vendido. NULL em item gravado antes da captura ou sem o campo. E a chave do vinculo USER_PRODUCT de sku_listing_links.';

-- A mesma forma de sku_listing_links. NOT VALID + VALIDATE: a verificação das
-- linhas existentes (todas NULL) não segura as gravações de pedido.
alter table public.order_items
  add constraint order_items_user_product_id_forma
  check (user_product_id is null or user_product_id ~ '^MLBU[0-9]+$') not valid;

alter table public.order_items
  validate constraint order_items_user_product_id_forma;
