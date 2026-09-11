-- ---------------------------------------------------------------------------
-- Os anuncios de UM SKU, pela definicao canonica de "vinculado" (D-316)
-- ---------------------------------------------------------------------------
--
-- O Dashboard do SKU listava os anuncios com `listings.sku_id = :sku`, que e a
-- definicao MAIS ESTREITA de vinculo que este repositorio tem -- e ela perde o
-- vinculo por VARIACAO. D-122 mediu o tamanho do buraco: 1.013 de 1.917
-- anuncios (52,8%) tem `sku_id` nulo E vinculo em `sku_listing_links`. A tela
-- do SKU dizia "1 anuncio deste SKU" onde /produtos dizia 2, para o mesmo SKU,
-- porque `get_sku_curation.listing_count` ja usa a definicao certa desde D-245.
--
-- Esta funcao e aquela CTE `anuncios` de `get_sku_curation` (20260904194000,
-- linhas 82-96) devolvendo as LINHAS em vez da contagem, mais o que a tela
-- precisa para GERIR o vinculo, e nao so para le-lo.
--
-- ## Por que funcao nova, e nao `p_sku_id` em `get_listings_dashboard`
--
-- Aquela e a funcao que D-305 teve de mover para plpgsql com
-- `force_custom_plan` porque o plano generico virava mais de 60 s. Pendurar
-- mais um filtro nela e mexer no caminho mais caro da casa para responder uma
-- pergunta estreita. Esta aqui sao duas CTEs sobre indices que ja existem.
--
-- ## O que ela devolve alem do obvio, e por que
--
--   links           as linhas de `sku_listing_links` daquele par (conta,
--                   anuncio), em jsonb. `remove_sku_listing_link` e
--                   `retarget_sku_listing_link` exigem `p_link_id`, e
--                   `listings` NAO tem id de vinculo: sem isto a tela sabe
--                   mostrar e nao sabe remover.
--   vinculo_forma   'item_inteiro' | 'variacao' | 'cache_sem_linha'. A
--                   terceira e a linha que so existe pelo cache de
--                   `listings.sku_id` e nao tem linha de vinculo -- nela nao
--                   ha o que remover, e a tela precisa dizer isso em vez de
--                   oferecer um botao que a RPC recusaria.
--   apenas_cache    `listings.sku_id` aponta para ESTE sku e NAO ha linha de
--                   vinculo. O nome diz o FATO, nao a causa, porque a causa
--                   tem duas: o vinculo foi removido e o sync (de 6 em 6 h)
--                   ainda nao reescreveu a projecao, OU a linha nasceu do
--                   remapeamento de republicacao, que copia o `sku_id` do
--                   anuncio pai (`complete_listing_relist_remap`). Nos dois
--                   casos a consequencia e a mesma: nao ha `link_id`, entao
--                   nao ha o que remover ali -- e dizer isso e melhor do que
--                   oferecer um botao que a RPC recusaria.
--
-- `listings.sku_id` NAO e uma segunda fonte de verdade: e cache denormalizado
-- que `ml-listings-fetch` reescreve a cada sync a partir de
-- `sku_listing_links` (ref_kind='ITEM' e variation_id is null). Por isso a
-- uniao, e por isso `apenas_cache` em vez de tentar "corrigir" a coluna aqui.
--
-- ## Autorizacao
--
-- `security invoker`: quem restringe e a RLS das duas tabelas -- `listings`
-- por `has_account_access(ml_account_id)` e `sku_listing_links` pela mesma
-- regra. Um `p_organization_id` forjado devolve VAZIO, nunca dado de outra
-- organizacao.
-- ---------------------------------------------------------------------------

create or replace function public.get_sku_listings(
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
    -- A uniao de D-122: uma linha por (conta, anuncio), venha o vinculo do
    -- cache direto ou da tabela de vinculo.
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
      -- `variation_id is null` e o vinculo do ANUNCIO INTEIRO; com valor, e de
      -- uma variacao. A distincao decide o que a tela oferece.
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
    -- O anuncio pode ter vinculo e ainda nao estar sincronizado: a linha de
    -- `listings` e que pode faltar, nao o vinculo. Nesse caso a tela mostra o
    -- MLB e diz que o resto nao foi sincronizado ainda.
    l.title,
    l.status,
    l.price,
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
  'Anuncios de um SKU pela definicao de vinculado de D-122 (D-316): uniao de listings.sku_id com sku_listing_links(ref_kind=ITEM), uma linha por (conta, anuncio). Devolve os ids de vinculo porque remove_/retarget_sku_listing_link exigem p_link_id, e vinculo_forma/apenas_cache porque a tela precisa distinguir o vinculo que se pode remover daquele que so existe na projecao do sync.';

revoke all on function public.get_sku_listings(uuid, uuid) from public, anon;
grant execute on function public.get_sku_listings(uuid, uuid) to authenticated;
