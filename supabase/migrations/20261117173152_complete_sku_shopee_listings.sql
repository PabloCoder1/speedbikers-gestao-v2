-- D-715: todos os anuncios Shopee do SKU, com ordem total para paginacao externa.
-- A identidade da loja desempata nomes, itens e variacoes iguais.

create or replace function public.get_sku_shopee_listings(p_organization_id uuid, p_sku_id uuid)
returns table (
  shopee_shop_id uuid,
  shop_name text,
  item_id bigint,
  model_id bigint,
  item_name text,
  model_name text,
  sku_anuncio text,
  item_status text,
  model_status text,
  currency text,
  current_price numeric,
  available_stock integer,
  vinculo_via text,
  manual_link_id uuid,
  environment text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    u.shopee_shop_id,
    sh.shop_name,
    u.item_id,
    u.model_id,
    u.item_name,
    u.model_name,
    u.sku_anuncio,
    u.item_status,
    u.model_status,
    u.currency,
    u.current_price,
    u.available_stock,
    u.vinculo_via,
    u.manual_link_id,
    sh.environment
  from public.shopee_listing_units u
  join public.shopee_shops sh on sh.id = u.shopee_shop_id
  where u.organization_id = p_organization_id
    and u.sku_id = p_sku_id
  order by sh.shop_name nulls last, u.item_name nulls last, u.item_id, u.model_id nulls first, u.shopee_shop_id;
$$;

comment on function public.get_sku_shopee_listings(uuid, uuid) is
  'Anuncios Shopee vinculados a um SKU (D-429), pelo vinculo manual ou pelo SKU do anuncio, com o ambiente da loja (D-432; sandbox nunca e venda real); leitura completa por paginas (D-715).';
