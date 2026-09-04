-- ============================================================
-- Curadoria ganha a coluna "Anuncios" do frame (D-245).
--
-- O frame `ProductsCuration` (App.tsx:4404) tem cinco colunas, e a quinta e
-- a contagem de anuncios do produto (3, 1, 2). A auditoria de fidelidade
-- classificou a ausencia como P1: o desvio registrado em D7 explicava as
-- colunas ACRESCENTADAS pela V3, nao a coluna do frame que ficou de fora — e
-- o dado existe.
--
-- `listing_count` conta os anuncios que VENDEM o SKU, com a mesma definicao
-- de "vinculado" que `/anuncios` usa (D-122): vinculo direto
-- (`listings.sku_id`) OU vinculo por variacao (`sku_listing_links` com
-- `ref_kind = 'ITEM'`), contados uma vez por (conta, anuncio). Contar so o
-- vinculo direto diria "0 anuncios" para um SKU que vende por variacao —
-- exatamente a classe de subcontagem que D-122 mediu (1.013 anuncios).
--
-- Tudo o mais e identico: DROP + CREATE porque a lista de retorno muda
-- (42P13); a coluna entra NO FIM para os consumidores posicionais nao se
-- deslocarem; grant e comment recriados.
-- ============================================================

drop function public.get_sku_curation(uuid, text, boolean, text, text, text, integer, integer);

create function public.get_sku_curation(
  p_organization_id uuid,
  p_brand text default null,
  p_missing_brand boolean default false,
  p_classified text default null,
  p_signal text default null,
  p_search text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  sku_id uuid,
  sku text,
  title text,
  brand text,
  supplier_brand text,
  supplier_brand_source text,
  supplier_brand_set_at timestamptz,
  stock_is_virtual boolean,
  stock_is_virtual_set_at timestamptz,
  snapshot_available numeric,
  snapshot_captured_at timestamptz,
  has_sentinel_signature boolean,
  units_sold_90d bigint,
  decision_diverges_from_signature boolean,
  total_count bigint,
  listing_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.check_sku_curation_writer(p_organization_id);

  return query
  with retrato as (
    select distinct on (s.sku_id, s.warehouse)
      s.sku_id, s.warehouse, s.available, s.captured_at
    from public.erp_stock_snapshots s
    where s.organization_id = p_organization_id
      and s.sku_id is not null
    order by s.sku_id, s.warehouse, s.captured_at desc
  ),
  retrato_agg as (
    select r.sku_id, sum(r.available) as available, max(r.captured_at) as captured_at
    from retrato r
    group by r.sku_id
  ),
  vendas as (
    select m.sku_id, sum(m.units_sold)::bigint as units_sold_90d
    from public.daily_sku_metrics m
    where m.organization_id = p_organization_id
      and m.sku_id is not null
      and m.metric_date >= (current_date - 89)
    group by m.sku_id
  ),
  anuncios as (
    -- Anuncios que vendem o SKU: vinculo direto OU por variacao, uma vez por
    -- (conta, anuncio) — a definicao de "vinculado" de /anuncios (D-122).
    select u.sku_id, count(*)::bigint as listing_count
    from (
      select l.sku_id, l.ml_account_id, l.item_id
      from public.listings l
      where l.organization_id = p_organization_id and l.sku_id is not null
      union
      select k.sku_id, k.ml_account_id, k.item_id
      from public.sku_listing_links k
      where k.organization_id = p_organization_id and k.ref_kind = 'ITEM' and k.item_id is not null
    ) u
    group by u.sku_id
  ),
  base as (
    select
      k.id as sku_id,
      k.sku,
      k.title,
      k.brand,
      k.supplier_brand,
      k.supplier_brand_source,
      k.supplier_brand_set_at,
      k.stock_is_virtual,
      k.stock_is_virtual_set_at,
      k.sku_key,
      ra.available as snapshot_available,
      ra.captured_at as snapshot_captured_at,
      case
        when ra.sku_id is null then null
        else (ra.available between 900 and 1000 or ra.available between 9900 and 10000)
      end as has_sentinel_signature,
      coalesce(v.units_sold_90d, 0)::bigint as units_sold_90d,
      coalesce(an.listing_count, 0)::bigint as listing_count
    from public.skus k
    left join retrato_agg ra on ra.sku_id = k.id
    left join vendas v on v.sku_id = k.id
    left join anuncios an on an.sku_id = k.id
    where k.organization_id = p_organization_id
  ),
  marcada as (
    select
      b.*,
      (b.stock_is_virtual_set_at is not null
        and b.has_sentinel_signature is not null
        and b.stock_is_virtual <> b.has_sentinel_signature) as decision_diverges_from_signature
    from base b
  ),
  filtrada as (
    select m.* from marcada m
    where (p_brand is null or m.supplier_brand = p_brand)
      and (not coalesce(p_missing_brand, false) or m.supplier_brand is null)
      and (
        p_classified is null
        or (p_classified = 'PENDENTE' and m.stock_is_virtual_set_at is null)
        or (p_classified = 'VIRTUAL' and m.stock_is_virtual_set_at is not null and m.stock_is_virtual)
        or (p_classified = 'FISICO' and m.stock_is_virtual_set_at is not null and not m.stock_is_virtual)
      )
      and (
        p_signal is null
        or (p_signal = 'SENTINELA' and m.has_sentinel_signature)
        or (p_signal = 'SEM_SINAL' and m.has_sentinel_signature is false)
        or (p_signal = 'SEM_RETRATO' and m.has_sentinel_signature is null)
        or (p_signal = 'DIVERGENTE' and m.decision_diverges_from_signature)
      )
      and (
        p_search is null
        or pg_catalog.btrim(p_search) = ''
        or m.sku_key like pg_catalog.upper(pg_catalog.btrim(p_search)) || '%'
        or m.title ilike '%' || pg_catalog.btrim(p_search) || '%'
      )
  )
  select
    f.sku_id, f.sku, f.title, f.brand,
    f.supplier_brand, f.supplier_brand_source, f.supplier_brand_set_at,
    f.stock_is_virtual, f.stock_is_virtual_set_at,
    f.snapshot_available, f.snapshot_captured_at,
    f.has_sentinel_signature, f.units_sold_90d, f.decision_diverges_from_signature,
    (count(*) over ())::bigint as total_count,
    f.listing_count
  from filtrada f
  order by
    f.decision_diverges_from_signature desc nulls last,
    f.has_sentinel_signature desc nulls last,
    f.sku
  limit greatest(coalesce(p_limit, 100), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function public.get_sku_curation(uuid, text, boolean, text, text, text, integer, integer) is
  'Mesa de curadoria (D-133/D-245): universo = todas as linhas de skus da organizacao; retrato mais recente do ERP por SKU; assinatura de sentinela (900-1000 / 9900-10000) como TERCEIRO estado quando nao ha retrato; vendas de 90 dias; divergencia entre decisao e assinatura; listing_count = anuncios que vendem o SKU (vinculo direto OU por variacao, definicao de /anuncios, D-122). SECURITY DEFINER com guarda private.check_sku_curation_writer.';

-- O Postgres da EXECUTE a PUBLIC em toda funcao nova (D-182/D-242): revogar
-- ANTES do grant, senao `anon` alcanca a RPC.
revoke execute on function public.get_sku_curation(uuid, text, boolean, text, text, text, integer, integer) from public, anon;
grant execute on function public.get_sku_curation(uuid, text, boolean, text, text, text, integer, integer) to authenticated, service_role;
