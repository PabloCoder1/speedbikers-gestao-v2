-- ============================================================
-- `listings.promotional_price` — o preço que o comprador PAGA agora,
-- quando o anúncio está numa campanha ativa do Mercado Livre.
--
-- O diagnóstico de SKU (D-317/D-318) compara `listings.price` entre
-- anúncios do mesmo SKU e acende "Preços muito diferentes" acima de 10%
-- de dispersão. `price` é o preço CADASTRADO, e o Mercado Livre deixa um
-- anúncio com o cadastrado em R$ 64,90 e outro em R$ 41,90 sem dispersão
-- real nenhuma quando o primeiro está com campanha ativa levando ao mesmo
-- R$ 41,90 na vitrine — a régua acendia comparando dois números que o
-- comprador nunca vê lado a lado.
--
-- Contrato de `GET /seller-promotions/items/{item_id}?app_version=v2`
-- CONFIRMADO AO VIVO em 2026-09-21, conta "Speedbikers (loja 1)" do Dev,
-- item MLB1384467402 (cadastrado 370,69):
--
--   [
--     {"type":"SELLER_CAMPAIGN","status":"started","price":249.99,"original_price":370.69,...},
--     {"type":"PRICE_DISCOUNT","status":"candidate","price":0,"original_price":370.69,...},
--     {"type":"DEAL","status":"candidate","price":0,"original_price":370.69,...}
--   ]
--
-- Só `status:"started"` é promoção realmente no ar; `"candidate"` é
-- campanha que o vendedor PODE ativar e vem com `price: 0` — o motivo de
-- `promotional_price` ser NULO por padrão, nunca zero.  A coluna é lida
-- por `apps/worker/src/handlers/ml-listings-fetch.ts`
-- (`@sb/mercado-livre` `getItemPromotions`/`effectivePromotionalPrice`),
-- que só chama o endpoint para anúncios ATIVOS — pausado/encerrado não
-- roda campanha (docs/MERCADO_LIVRE.md secao 2.8).
-- ============================================================

alter table public.listings
  add column if not exists promotional_price numeric;

comment on column public.listings.promotional_price is
  'Preço com a campanha ativa do Mercado Livre aplicada (status "started" em GET /seller-promotions/items/{item_id}), lido só para anúncios ativos. NULO quando não há promoção em andamento — nunca zero (D-389, "candidate" vem com price=0 e não é usado).';

-- `get_sku_listings` (20260911190000) precisa expor a coluna nova: o
-- diagnóstico do SKU (`apps/web/lib/sku-diagnostico.ts`) lê `AnuncioDoSku`
-- desta RPC, não da tabela direto. `returns table` não aceita
-- `create or replace` com coluna nova — precisa dropar antes.
drop function if exists public.get_sku_listings(uuid, uuid);

create function public.get_sku_listings(
  p_organization_id uuid,
  p_sku_id uuid
)
returns table (
  listing_id uuid,
  ml_account_id uuid,
  account_label text,
  item_id text,
  title text,
  status text,
  price numeric,
  promotional_price numeric,
  available_quantity integer,
  synced_at timestamptz,
  vinculo_forma text,
  apenas_cache boolean,
  links jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  with pares as (
    select l.ml_account_id, l.item_id
    from public.listings l
    where l.organization_id = p_organization_id and l.sku_id = p_sku_id
    union
    select k.ml_account_id, k.item_id
    from public.sku_listing_links k
    where k.organization_id = p_organization_id
      and k.sku_id = p_sku_id
      and k.ref_kind = 'ITEM'
      and k.item_id is not null
  ),
  vinculos as (
    select
      k.ml_account_id,
      k.item_id,
      bool_or(k.variation_id is null) as tem_item_inteiro,
      jsonb_agg(
        jsonb_build_object(
          'id', k.id,
          'variation_id', k.variation_id,
          'source', k.source,
          'confirmed_at', k.confirmed_at
        )
        order by k.variation_id nulls first
      ) as links
    from public.sku_listing_links k
    where k.organization_id = p_organization_id
      and k.sku_id = p_sku_id
      and k.ref_kind = 'ITEM'
      and k.item_id is not null
    group by k.ml_account_id, k.item_id
  )
  select
    l.id,
    l.ml_account_id,
    a.label,
    p.item_id,
    l.title,
    l.status,
    l.price,
    l.promotional_price,
    l.available_quantity,
    l.synced_at,
    case
      when v.tem_item_inteiro then 'item_inteiro'
      when v.links is not null then 'variacao'
      else 'cache_sem_linha'
    end,
    (l.sku_id = p_sku_id and v.links is null),
    coalesce(v.links, '[]'::jsonb)
  from pares p
  left join public.listings l
    on l.organization_id = p_organization_id
   and l.ml_account_id = p.ml_account_id
   and l.item_id = p.item_id
  left join public.ml_accounts a on a.id = p.ml_account_id
  left join vinculos v on v.ml_account_id = p.ml_account_id and v.item_id = p.item_id
  order by a.label nulls last, l.title nulls last, p.item_id
$$;

comment on function public.get_sku_listings is
  'Anuncios de um SKU pela definicao de vinculado de D-122 (D-316): uniao de listings.sku_id com sku_listing_links(ref_kind=ITEM), uma linha por (conta, anuncio). promotional_price (20260921120000) e o preco com campanha ativa do ML, NULO sem promocao. Devolve os ids de vinculo porque remove_/retarget_sku_listing_link exigem p_link_id, e vinculo_forma/apenas_cache porque a tela precisa distinguir o vinculo que se pode remover daquele que so existe na projecao do sync.';

revoke all on function public.get_sku_listings(uuid, uuid) from public, anon;
grant execute on function public.get_sku_listings(uuid, uuid) to authenticated;
