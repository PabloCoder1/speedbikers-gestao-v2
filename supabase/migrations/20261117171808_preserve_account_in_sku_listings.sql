-- D-714: o vínculo tem conta mesmo antes da sincronização do anúncio.
-- A ordem termina na chave da linha para desempatar contas com o mesmo nome e MLB.

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
    p.ml_account_id,
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
  -- D-631: o anuncio excluido no Mercado Livre sai do SKU; o par sem linha de
  -- anuncio (o vinculo que so existe no cache) continua.
  where l.deleted_at is null
  order by a.label nulls last, l.title nulls last, p.item_id, p.ml_account_id
$$;
