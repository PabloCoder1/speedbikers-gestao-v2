-- ============================================================
-- D-631 b -- o anuncio excluido no Mercado Livre fora das contagens e dos
-- detectores.
--
-- A D-631 (20261021170000) escondeu o excluido da lista e da faixa de
-- /anuncios, dos anuncios do SKU e da visao de vinculos. O A2 levantou (21/10)
-- as outras leituras diretas de `listings` que o mostrariam como vivo -- e no
-- 404 o status fica o ultimo visto, entao so `deleted_at` diz a verdade:
--
-- - get_products_overview (/produtos) e get_sku_curation: a contagem de
--   anuncios do SKU (a uniao da D-122) sem o excluido nem o vinculo dele;
-- - get_ml_account_cards (/contas): a contagem por conta;
-- - get_link_integrity: o excluido sem vinculo nao e trabalho a fazer;
-- - recalcular_queda_anuncios (C-79): sem linha de queda para o excluido;
-- - get_detector_frete (a Central e a /central): o excluido nao vira alerta
--   de frete, mas segue na comparacao com os irmaos.
--
-- Os corpos sao as definicoes atuais (pg_get_functiondef do banco com todas
-- as migrations), com a mesma assinatura, o mesmo retorno e as mesmas
-- clausulas SET. `sincronizar_alertas_central` le `listings` so para achar a
-- conta do alerta de frete, que agora ja chega sem o excluido.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_products_overview(p_organization_id uuid, p_classified text DEFAULT NULL::text, p_signal text DEFAULT NULL::text, p_brand text DEFAULT NULL::text, p_missing_brand boolean DEFAULT false, p_category text DEFAULT NULL::text, p_missing_category boolean DEFAULT false, p_kind text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_listing text DEFAULT NULL::text, p_sales text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_order text DEFAULT 'curadoria'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  resultado jsonb;
  busca text := nullif(pg_catalog.btrim(coalesce(p_search, '')), '');
  v_tem_shopee boolean;
begin
  if not private.has_org_role(p_organization_id, array['ADMIN', 'GESTOR']) then
    raise exception 'sem permissao para curar o catalogo desta organizacao';
  end if;

  v_tem_shopee := exists (
    select 1 from public.shopee_shops s where s.organization_id = p_organization_id and s.environment = 'live'
  );

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
    -- A definicao de "vinculado" de /anuncios (D-122), igual a de
    -- `get_sku_curation`.
    select u.sku_id, count(*)::bigint as listing_count
    from (
      select l.sku_id, l.ml_account_id, l.item_id
      from public.listings l
      where l.organization_id = p_organization_id and l.sku_id is not null
        -- D-631 b: o anuncio excluido no Mercado Livre nao conta.
        and l.deleted_at is null
      union
      select k.sku_id, k.ml_account_id, k.item_id
      from public.sku_listing_links k
      where k.organization_id = p_organization_id and k.ref_kind = 'ITEM' and k.item_id is not null
        -- D-631 b: nem o vinculo cujo anuncio foi excluido.
        and not exists (
          select 1 from public.listings d
          where d.ml_account_id = k.ml_account_id and d.item_id = k.item_id and d.deleted_at is not null
        )
    ) u
    group by u.sku_id
  ),
  -- D-445: o anuncio Shopee vinculado ao SKU (D-429: manual ou pelo SKU do
  -- anuncio), um por item de loja live; a venda de 90 dias pelo grao de SKU
  -- da Shopee (D-439), so pedido valido de loja live.
  anuncios_shopee as (
    select u.sku_id, count(distinct (u.shopee_shop_id, u.item_id))::bigint as listing_count
    from public.shopee_listing_units u
    join public.shopee_shops sh on sh.id = u.shopee_shop_id
    where u.organization_id = p_organization_id
      and u.sku_id is not null
      and sh.environment = 'live'
    group by u.sku_id
  ),
  vendas_shopee as (
    select it.sku_id, sum(it.quantity)::bigint as units_sold_90d
    from public.shopee_sales_items it
    where it.organization_id = p_organization_id
      and it.sku_id is not null
      and it.environment = 'live'
      and it.situacao = 'VALIDA'
      and it.dia >= (current_date - 89)
    group by it.sku_id
  ),
  marcada as materialized (
    select
      k.id as sku_id,
      k.sku,
      k.sku_key,
      k.title,
      k.brand,
      k.supplier_brand,
      k.supplier_brand_source,
      k.stock_is_virtual,
      k.stock_is_virtual_set_at,
      k.kind,
      k.is_active,
      k.is_discontinued,
      k.retail_price,
      k.purchase_cost,
      k.created_at,
      k.updated_at,
      ra.available as snapshot_available,
      ra.captured_at as snapshot_captured_at,
      case
        when ra.sku_id is null then null
        else (ra.available between 900 and 1000 or ra.available between 9900 and 10000)
      end as has_sentinel_signature,
      coalesce(v.units_sold_90d, 0)::bigint as units_sold_90d,
      coalesce(an.listing_count, 0)::bigint as listing_count,
      -- Sem loja Shopee live, nao ha o que dizer: NULO, nao 0.
      case when v_tem_shopee then coalesce(ans.listing_count, 0) end::bigint as shopee_listing_count,
      case when v_tem_shopee then coalesce(vs.units_sold_90d, 0) end::bigint as shopee_units_sold_90d
    from public.skus k
    left join retrato_agg ra on ra.sku_id = k.id
    left join vendas v on v.sku_id = k.id
    left join anuncios an on an.sku_id = k.id
    left join anuncios_shopee ans on ans.sku_id = k.id
    left join vendas_shopee vs on vs.sku_id = k.id
    where k.organization_id = p_organization_id
  ),
  eixos as materialized (
    select
      m.*,
      (m.stock_is_virtual_set_at is not null
        and m.has_sentinel_signature is not null
        and m.stock_is_virtual <> m.has_sentinel_signature) as divergente,
      case
        when not m.is_active then 'INATIVO'
        when m.is_discontinued then 'ENCERRANDO'
        else 'ATIVO'
      end as situacao,
      -- Um booleano por eixo: a linha passa ou nao naquele filtro.
      (p_classified is null
        or (p_classified = 'PENDENTE' and m.stock_is_virtual_set_at is null)
        or (p_classified = 'VIRTUAL' and m.stock_is_virtual_set_at is not null and m.stock_is_virtual)
        or (p_classified = 'FISICO' and m.stock_is_virtual_set_at is not null and not m.stock_is_virtual)
      ) as ok_estado,
      (p_brand is null or m.supplier_brand = p_brand)
        and (not coalesce(p_missing_brand, false) or m.supplier_brand is null) as ok_marca,
      (p_category is null or m.brand = p_category)
        and (not coalesce(p_missing_category, false) or m.brand is null) as ok_categoria,
      (p_kind is null or m.kind = p_kind) as ok_tipo,
      -- D-445: COM/SEM olham os dois marketplaces; SO_ML, SO_SHOPEE e AMBOS
      -- dizem onde. Sem loja Shopee live, e o comportamento de antes.
      (p_listing is null
        or (p_listing = 'COM' and (m.listing_count > 0 or coalesce(m.shopee_listing_count, 0) > 0))
        or (p_listing = 'SEM' and m.listing_count = 0 and coalesce(m.shopee_listing_count, 0) = 0)
        or (p_listing = 'SO_ML' and m.listing_count > 0 and coalesce(m.shopee_listing_count, 0) = 0)
        or (p_listing = 'SO_SHOPEE' and m.listing_count = 0 and coalesce(m.shopee_listing_count, 0) > 0)
        or (p_listing = 'AMBOS' and m.listing_count > 0 and coalesce(m.shopee_listing_count, 0) > 0)) as ok_anuncios,
      (p_sales is null
        or (p_sales = 'COM' and (m.units_sold_90d > 0 or coalesce(m.shopee_units_sold_90d, 0) > 0))
        or (p_sales = 'SEM' and m.units_sold_90d = 0 and coalesce(m.shopee_units_sold_90d, 0) = 0)
        or (p_sales = 'SO_ML' and m.units_sold_90d > 0 and coalesce(m.shopee_units_sold_90d, 0) = 0)
        or (p_sales = 'SO_SHOPEE' and m.units_sold_90d = 0 and coalesce(m.shopee_units_sold_90d, 0) > 0)
        or (p_sales = 'AMBOS' and m.units_sold_90d > 0 and coalesce(m.shopee_units_sold_90d, 0) > 0)) as ok_vendas,
      (busca is null
        or m.sku_key like pg_catalog.upper(busca) || '%'
        or m.title ilike '%' || busca || '%') as ok_busca
    from marcada m
  ),
  com_sinal as materialized (
    select
      e.*,
      (p_signal is null
        or (p_signal = 'SENTINELA' and e.has_sentinel_signature)
        or (p_signal = 'SEM_SINAL' and e.has_sentinel_signature is false)
        or (p_signal = 'SEM_RETRATO' and e.has_sentinel_signature is null)
        or (p_signal = 'DIVERGENTE' and e.divergente)) as ok_sinal,
      (p_status is null or e.situacao = p_status) as ok_situacao
    from eixos e
  ),
  filtrada as (
    select c.*
    from com_sinal c
    where c.ok_estado and c.ok_sinal and c.ok_marca and c.ok_categoria and c.ok_tipo
      and c.ok_situacao and c.ok_anuncios and c.ok_vendas and c.ok_busca
  ),
  pagina as (
    select f.*
    from filtrada f
    order by
      case when p_order = 'atualizado' then f.updated_at
           when p_order = 'criado'     then f.created_at end desc nulls last,
      (case when p_order not in ('atualizado', 'criado') or p_order is null
            then f.divergente end) desc nulls last,
      (case when p_order not in ('atualizado', 'criado') or p_order is null
            then f.has_sentinel_signature end) desc nulls last,
      f.sku
    limit greatest(coalesce(p_limit, 50), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrada),
    'linhas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sku_id', p.sku_id,
               'sku', p.sku,
               'title', p.title,
               'brand', p.brand,
               'supplier_brand', p.supplier_brand,
               'supplier_brand_source', p.supplier_brand_source,
               'stock_is_virtual', p.stock_is_virtual,
               'stock_is_virtual_set_at', p.stock_is_virtual_set_at,
               'snapshot_available', p.snapshot_available,
               'has_sentinel_signature', p.has_sentinel_signature,
               'units_sold_90d', p.units_sold_90d,
               'decision_diverges_from_signature', p.divergente,
               'listing_count', p.listing_count,
               'shopee_listing_count', p.shopee_listing_count,
               'shopee_units_sold_90d', p.shopee_units_sold_90d,
               'kind', p.kind,
               'situacao', p.situacao,
               'retail_price', p.retail_price,
               'purchase_cost', p.purchase_cost,
               'created_at', p.created_at,
               'updated_at', p.updated_at
             ) order by
               case when p_order = 'atualizado' then p.updated_at
                    when p_order = 'criado'     then p.created_at end desc nulls last,
               (case when p_order not in ('atualizado', 'criado') or p_order is null
                     then p.divergente end) desc nulls last,
               (case when p_order not in ('atualizado', 'criado') or p_order is null
                     then p.has_sentinel_signature end) desc nulls last,
               p.sku)
      from pagina p), '[]'::jsonb),
    'facetas', jsonb_build_object(
      'estado', (
        select jsonb_build_object(
          'todos', count(*),
          'pendente', count(*) filter (where c.stock_is_virtual_set_at is null),
          'virtual', count(*) filter (where c.stock_is_virtual_set_at is not null and c.stock_is_virtual),
          'fisico', count(*) filter (where c.stock_is_virtual_set_at is not null and not c.stock_is_virtual))
        from com_sinal c
        where c.ok_sinal and c.ok_marca and c.ok_categoria and c.ok_tipo
          and c.ok_situacao and c.ok_anuncios and c.ok_vendas and c.ok_busca),
      'sinal', (
        select jsonb_build_object(
          'todos', count(*),
          'sentinela', count(*) filter (where c.has_sentinel_signature),
          'sem_sinal', count(*) filter (where c.has_sentinel_signature is false),
          'sem_retrato', count(*) filter (where c.has_sentinel_signature is null),
          'divergente', count(*) filter (where c.divergente))
        from com_sinal c
        where c.ok_estado and c.ok_marca and c.ok_categoria and c.ok_tipo
          and c.ok_situacao and c.ok_anuncios and c.ok_vendas and c.ok_busca),
      'marcas', coalesce((
        select jsonb_agg(jsonb_build_object('valor', x.valor, 'n', x.n) order by x.n desc, x.valor nulls first)
        from (
          select c.supplier_brand as valor, count(*) as n
          from com_sinal c
          where c.ok_estado and c.ok_sinal and c.ok_categoria and c.ok_tipo
            and c.ok_situacao and c.ok_anuncios and c.ok_vendas and c.ok_busca
          group by c.supplier_brand
        ) x), '[]'::jsonb),
      'categorias', coalesce((
        select jsonb_agg(jsonb_build_object('valor', x.valor, 'n', x.n) order by x.n desc, x.valor nulls first)
        from (
          select c.brand as valor, count(*) as n
          from com_sinal c
          where c.ok_estado and c.ok_sinal and c.ok_marca and c.ok_tipo
            and c.ok_situacao and c.ok_anuncios and c.ok_vendas and c.ok_busca
          group by c.brand
        ) x), '[]'::jsonb),
      'tipo', (
        select jsonb_build_object(
          'todos', count(*),
          'produto', count(*) filter (where c.kind = 'PRODUTO'),
          'kit', count(*) filter (where c.kind = 'KIT'))
        from com_sinal c
        where c.ok_estado and c.ok_sinal and c.ok_marca and c.ok_categoria
          and c.ok_situacao and c.ok_anuncios and c.ok_vendas and c.ok_busca),
      'situacao', (
        select jsonb_build_object(
          'todos', count(*),
          'ativo', count(*) filter (where c.situacao = 'ATIVO'),
          'encerrando', count(*) filter (where c.situacao = 'ENCERRANDO'),
          'inativo', count(*) filter (where c.situacao = 'INATIVO'))
        from com_sinal c
        where c.ok_estado and c.ok_sinal and c.ok_marca and c.ok_categoria
          and c.ok_tipo and c.ok_anuncios and c.ok_vendas and c.ok_busca),
      'anuncios', (
        select jsonb_build_object(
          'todos', count(*),
          'com', count(*) filter (where c.listing_count > 0 or coalesce(c.shopee_listing_count, 0) > 0),
          'sem', count(*) filter (where c.listing_count = 0 and coalesce(c.shopee_listing_count, 0) = 0),
          'so_ml', count(*) filter (where c.listing_count > 0 and coalesce(c.shopee_listing_count, 0) = 0),
          'so_shopee', count(*) filter (where c.listing_count = 0 and coalesce(c.shopee_listing_count, 0) > 0),
          'ambos', count(*) filter (where c.listing_count > 0 and coalesce(c.shopee_listing_count, 0) > 0))
        from com_sinal c
        where c.ok_estado and c.ok_sinal and c.ok_marca and c.ok_categoria
          and c.ok_tipo and c.ok_situacao and c.ok_vendas and c.ok_busca),
      'vendas', (
        select jsonb_build_object(
          'todos', count(*),
          'com', count(*) filter (where c.units_sold_90d > 0 or coalesce(c.shopee_units_sold_90d, 0) > 0),
          'sem', count(*) filter (where c.units_sold_90d = 0 and coalesce(c.shopee_units_sold_90d, 0) = 0),
          'so_ml', count(*) filter (where c.units_sold_90d > 0 and coalesce(c.shopee_units_sold_90d, 0) = 0),
          'so_shopee', count(*) filter (where c.units_sold_90d = 0 and coalesce(c.shopee_units_sold_90d, 0) > 0),
          'ambos', count(*) filter (where c.units_sold_90d > 0 and coalesce(c.shopee_units_sold_90d, 0) > 0))
        from com_sinal c
        where c.ok_estado and c.ok_sinal and c.ok_marca and c.ok_categoria
          and c.ok_tipo and c.ok_situacao and c.ok_anuncios and c.ok_busca)
    ),
    -- O catalogo INTEIRO, sem filtro nenhum: os cartoes de cima. Sao estados do
    -- catalogo, nao metricas catalogadas (D-245).
    'resumo', (
      select jsonb_build_object(
        'total', count(*),
        'nunca_classificados', count(*) filter (where e.stock_is_virtual_set_at is null),
        'virtuais', count(*) filter (where e.stock_is_virtual_set_at is not null and e.stock_is_virtual),
        'sem_marca', count(*) filter (where e.supplier_brand is null),
        'a_revisar', count(*) filter (where e.divergente),
        'sem_anuncio', count(*) filter (where e.listing_count = 0 and coalesce(e.shopee_listing_count, 0) = 0 and e.is_active),
        'sem_venda_90d', count(*) filter (where e.units_sold_90d = 0 and coalesce(e.shopee_units_sold_90d, 0) = 0 and e.is_active),
        'sem_anuncio_ml', count(*) filter (where e.listing_count = 0 and e.is_active),
        'sem_venda_90d_ml', count(*) filter (where e.units_sold_90d = 0 and e.is_active),
        'tem_shopee', v_tem_shopee,
        'encerrando', count(*) filter (where e.situacao = 'ENCERRANDO'),
        'retrato_em', max(e.snapshot_captured_at))
      from eixos e)
  )
  into resultado;

  return resultado;
end;
$function$;


CREATE OR REPLACE FUNCTION public.get_sku_curation(p_organization_id uuid, p_brand text DEFAULT NULL::text, p_missing_brand boolean DEFAULT false, p_classified text DEFAULT NULL::text, p_signal text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_order text DEFAULT 'curadoria'::text)
 RETURNS TABLE(sku_id uuid, sku text, title text, brand text, supplier_brand text, supplier_brand_source text, supplier_brand_set_at timestamp with time zone, stock_is_virtual boolean, stock_is_virtual_set_at timestamp with time zone, snapshot_available numeric, snapshot_captured_at timestamp with time zone, has_sentinel_signature boolean, units_sold_90d bigint, decision_diverges_from_signature boolean, total_count bigint, listing_count bigint, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
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
        -- D-631 b: o anuncio excluido no Mercado Livre nao conta.
        and l.deleted_at is null
      union
      select k.sku_id, k.ml_account_id, k.item_id
      from public.sku_listing_links k
      where k.organization_id = p_organization_id and k.ref_kind = 'ITEM' and k.item_id is not null
        -- D-631 b: nem o vinculo cujo anuncio foi excluido.
        and not exists (
          select 1 from public.listings d
          where d.ml_account_id = k.ml_account_id and d.item_id = k.item_id and d.deleted_at is not null
        )
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
      k.created_at,
      k.updated_at,
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
    f.listing_count,
    f.created_at, f.updated_at
  from filtrada f
  order by
    -- A data escolhida manda; nas outras ordens este termo e NULO e nao
    -- interfere.
    case when p_order = 'atualizado' then f.updated_at
         when p_order = 'criado'     then f.created_at end desc nulls last,
    -- A ordem de CURADORIA (divergente primeiro, depois sentinela) so vale
    -- quando nenhuma data foi pedida -- e vale tambem para valor
    -- desconhecido, que e o que o `is null` cobre.
    (case when p_order not in ('atualizado', 'criado') or p_order is null
          then f.decision_diverges_from_signature end) desc nulls last,
    (case when p_order not in ('atualizado', 'criado') or p_order is null
          then f.has_sentinel_signature end) desc nulls last,
    -- DESEMPATE ESTAVEL, em toda ordem: `updated_at` repetido entre linhas
    -- (uma importacao inteira grava o mesmo instante) deixaria a paginacao
    -- livre para repetir ou pular SKU entre paginas.
    f.sku
  limit greatest(coalesce(p_limit, 100), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$function$;


CREATE OR REPLACE FUNCTION public.get_ml_account_cards(p_organization_id uuid)
 RETURNS TABLE(id uuid, label text, slug text, seller_id bigint, status text, connected_at timestamp with time zone, last_error text, listings_count bigint, last_sync_at timestamp with time zone, scope_count integer, credential_updated_at timestamp with time zone, token_expired boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    a.id,
    a.label,
    a.slug,
    a.seller_id,
    a.status,
    a.connected_at,
    a.last_error,
    -- Contagem por conta em SQL, nunca uma consulta por cartao no servidor
    -- do Next (`docs/ARCHITECTURE.md` secao 21).
    -- D-631 b: o anuncio excluido no Mercado Livre nao conta.
    (select count(*) from public.listings l where l.ml_account_id = a.id and l.deleted_at is null) as listings_count,
    (select max(s.finished_at)
       from public.sync_runs s
      where s.ml_account_id = a.id and s.status = 'done') as last_sync_at,
    array_length(c.scopes, 1) as scope_count,
    c.updated_at as credential_updated_at,
    -- Vencido numa conta conectada = a renovacao parou. Sem credencial, nao
    -- ha o que afirmar: `null`, e a tela diz "sem credencial" em vez de
    -- "em dia" (D-067 -- ausencia nao e o valor benigno).
    case when c.access_token_expires_at is null then null
         else c.access_token_expires_at < now() end as token_expired
  from public.ml_accounts a
  left join public.ml_credentials c on c.ml_account_id = a.id
  where a.organization_id = p_organization_id
    -- O MESMO predicado de `ml_accounts_select_permitted`. Uma definicao de
    -- quem ve conta, nao duas.
    and (
      a.id in (select private.accessible_accounts())
      or private.has_org_role(a.organization_id, array['ADMIN'])
    )
  order by a.label
$function$;


CREATE OR REPLACE FUNCTION public.get_link_integrity(p_organization_id uuid, p_days integer DEFAULT 90)
 RETURNS TABLE(ml_account_id uuid, account_label text, listings_total bigint, listings_ativos bigint, com_vinculo bigint, sem_vinculo bigint, pct_vinculado numeric, candidatos_abertos bigint, vendidos_no_periodo bigint, vendidos_sem_vinculo bigint, receita_sem_vinculo numeric)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
begin
  return query
  with contas as (
    select a.id, a.label
    from public.ml_accounts a
    where a.organization_id = p_organization_id
  ),
  catalogo as (
    select l.ml_account_id,
           count(*) as total,
           count(*) filter (where l.status = 'active') as ativos,
           -- D-313: `l.sku_id is not null` ENTROU. Sem ele esta coluna so
           -- conhecia o vinculo gravado em `sku_listing_links`, e o vinculo
           -- direto (a coluna `sku_id` do proprio anuncio) contava como SEM
           -- VINCULO -- a mesma palavra com duas definicoes na mesma tela.
           count(*) filter (where l.sku_id is not null or exists (
             select 1 from public.sku_listing_links k
             where k.ml_account_id = l.ml_account_id and k.item_id = l.item_id
           )) as com_vinculo
    from public.listings l
    where l.organization_id = p_organization_id
      -- D-631 b: o anuncio excluido no Mercado Livre nao e trabalho de vinculo.
      and l.deleted_at is null
    group by l.ml_account_id
  ),
  candidatos as (
    select c.ml_account_id, count(*) as abertos
    from public.link_candidates c
    where c.organization_id = p_organization_id and c.status = 'OPEN'
    group by c.ml_account_id
  ),
  -- Fonte INDEPENDENTE: item que vendeu existe, quer a varredura o conheça
  -- ou não. É o único número desta tela que não depende do pipeline auditado.
  vendas as (
    select o.ml_account_id,
           count(distinct oi.item_id) as itens,
           count(distinct oi.item_id) filter (where not exists (
             select 1 from public.sku_listing_links k
             where k.ml_account_id = o.ml_account_id and k.item_id = oi.item_id
           )) as itens_sem_vinculo,
           sum(oi.unit_price * oi.quantity) filter (where not exists (
             select 1 from public.sku_listing_links k
             where k.ml_account_id = o.ml_account_id and k.item_id = oi.item_id
           )) as receita_sem_vinculo
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.organization_id = p_organization_id
      and o.status in ('paid', 'partially_refunded')
      and o.date_created >= (now() - make_interval(days => p_days))
      and oi.item_id is not null
    group by o.ml_account_id
  )
  select
    c.id,
    c.label,
    coalesce(cat.total, 0)::bigint,
    coalesce(cat.ativos, 0)::bigint,
    coalesce(cat.com_vinculo, 0)::bigint,
    (coalesce(cat.total, 0) - coalesce(cat.com_vinculo, 0))::bigint,
    case
      when coalesce(cat.total, 0) = 0 then null
      else round(100.0 * coalesce(cat.com_vinculo, 0) / cat.total, 1)
    end,
    coalesce(cand.abertos, 0)::bigint,
    coalesce(v.itens, 0)::bigint,
    coalesce(v.itens_sem_vinculo, 0)::bigint,
    coalesce(v.receita_sem_vinculo, 0)::numeric
  from contas c
  left join catalogo cat on cat.ml_account_id = c.id
  left join candidatos cand on cand.ml_account_id = c.id
  left join vendas v on v.ml_account_id = c.id
  order by c.label;
end;
$function$;


CREATE OR REPLACE FUNCTION public.recalcular_queda_anuncios(p_organization_id uuid, p_hoje date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
 SET work_mem TO '64MB'
AS $function$
declare
  -- N, num lugar so: as janelas anteriores de mesmo tamanho.
  c_janelas constant integer := 8;
  v_hoje date := coalesce(p_hoje, (now() at time zone 'America/Sao_Paulo')::date);
  v_ate date := v_hoje - 1;
  v_agora timestamptz := now();
  v_linhas bigint;
  v_queda bigint;
begin
  delete from public.listing_sales_drop d where d.organization_id = p_organization_id;

  insert into public.listing_sales_drop
    (organization_id, ml_account_id, item_id, periodo_dias, periodo_de, periodo_ate,
     unidades_periodo, amostras, media_anterior, desvio, z, estado, calculado_em)
  with periodos(p) as (values (7), (15), (30), (60), (90)),
  anuncios as (
    select l.ml_account_id, l.item_id
    from public.listings l
    where l.organization_id = p_organization_id
      -- D-631 b: o anuncio excluido para de vender; a queda nele seria ruido.
      and l.deleted_at is null
  ),
  -- A metrica da organizacao, lida UMA vez e em sequencia: sem limite
  -- inferior de data, o plano le a tabela (~3,9 mil paginas, ~200 ms em
  -- producao em 21/10) em vez de visitar ~150 mil paginas pelo indice.
  diario as materialized (
    select m.ml_account_id, m.mlb_id, m.metric_date, m.units_sold
    from public.daily_listing_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date <= v_ate
  ),
  -- O anuncio "comeca" na primeira venda: a V3 ainda nao guarda a data de
  -- inicio do Mercado Livre. E conservador -- o anuncio antigo que nunca
  -- vendeu fica "sem historico", nunca "sem queda".
  primeira as (
    select d.ml_account_id, d.mlb_id, min(d.metric_date) as primeira_venda
    from diario d
    group by d.ml_account_id, d.mlb_id
  ),
  -- Unidades por janela: k = 0 e o periodo (v_ate - P + 1 .. v_ate); k = 1..8
  -- as anteriores de mesmo tamanho. A metrica so tem linha em dia com venda
  -- (`units_sold > 0`): janela sem linha e venda zero.
  vendas as (
    select d.ml_account_id, d.mlb_id, p.p, ((v_ate - d.metric_date) / p.p) as k, sum(d.units_sold) as unidades
    from diario d
    join periodos p on d.metric_date > v_ate - (c_janelas + 1) * p.p
    group by d.ml_account_id, d.mlb_id, p.p, ((v_ate - d.metric_date) / p.p)
  ),
  -- A janela anterior so conta se o anuncio ja existia nela inteira.
  janelas as (
    select a.ml_account_id, a.item_id, p.p, coalesce(v.unidades, 0) as unidades
    from anuncios a
    join primeira f on f.ml_account_id = a.ml_account_id and f.mlb_id = a.item_id
    cross join periodos p
    cross join generate_series(1, c_janelas) as k(k)
    left join vendas v on v.ml_account_id = a.ml_account_id and v.mlb_id = a.item_id and v.p = p.p and v.k = k.k
    where v_ate - (k.k + 1) * p.p + 1 >= f.primeira_venda
  ),
  base as (
    select j.ml_account_id, j.item_id, j.p,
           count(*)::integer as amostras,
           avg(j.unidades) as media,
           stddev_samp(j.unidades) as desvio
    from janelas j
    group by j.ml_account_id, j.item_id, j.p
  ),
  medido as (
    select a.ml_account_id, a.item_id, p.p,
           coalesce(v.unidades, 0)::bigint as unidades,
           coalesce(b.amostras, 0) as amostras,
           b.media, b.desvio,
           case when coalesce(b.amostras, 0) >= 4 and b.media > 0 and b.desvio > 0
                then (coalesce(v.unidades, 0) - b.media) / b.desvio end as z
    from anuncios a
    cross join periodos p
    left join base b on b.ml_account_id = a.ml_account_id and b.item_id = a.item_id and b.p = p.p
    left join vendas v on v.ml_account_id = a.ml_account_id and v.mlb_id = a.item_id and v.p = p.p and v.k = 0
  )
  select p_organization_id, m.ml_account_id, m.item_id, m.p, v_ate - m.p + 1, v_ate,
         m.unidades, m.amostras, round(m.media, 4), round(m.desvio, 4), round(m.z, 4),
         case when m.z is null then 'sem_historico' when m.z <= -2 then 'queda' else 'normal' end,
         v_agora
  from medido m;

  get diagnostics v_linhas = row_count;

  select count(*) into v_queda
  from public.listing_sales_drop d
  where d.organization_id = p_organization_id and d.estado = 'queda';

  return jsonb_build_object('linhas', v_linhas, 'em_queda', v_queda, 'periodo_ate', v_ate);
end;
$function$;


CREATE OR REPLACE FUNCTION public.get_detector_frete(p_organization_id uuid, p_hoje date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET plan_cache_mode TO 'force_custom_plan'
 SET work_mem TO '16MB'
AS $function$
declare
  v_hoje date := coalesce(p_hoje, (now() at time zone 'America/Sao_Paulo')::date);
  v_ini timestamptz := ((v_hoje - 90)::timestamp at time zone 'America/Sao_Paulo');
  v_corte timestamptz := ((v_hoje - 14)::timestamp at time zone 'America/Sao_Paulo');
  v_fim timestamptz := (v_hoje::timestamp at time zone 'America/Sao_Paulo');
begin
  return (
  -- D-409: as vendas de um item só, com frete capturado, vêm de
  -- `shipping_sales`, mantida por gatilhos com a MESMA regra que as CTEs
  -- `pedidos` e `linhas` aplicavam lendo `orders`, `order_financials` e
  -- `order_items` pedido a pedido -- 79 mil pedidos em páginas espalhadas.
  -- `item_id` continua sendo o id da LINHA (as CTEs de custo abaixo são as de
  -- `get_faturamento`, sem mudança); o anúncio é `anuncio`.
  with linhas as materialized (
    select
      s.order_id,
      s.ml_account_id,
      s.date_created,
      s.shipping_cost as frete,
      s.line_id as item_id,
      s.listing_id as anuncio,
      s.sku_id,
      s.title,
      1 as quantity,
      s.unit_price as preco,
      s.sale_fee as comissao
    from public.shipping_sales s
    where s.organization_id = p_organization_id
      and s.date_created >= v_ini
      and s.date_created < v_fim
  ),
  -- ── custo: as CTEs de get_faturamento (D-356), só com as datas da janela ──
  skus_janela as materialized (
    select distinct l.sku_id
    from linhas l
    where l.sku_id is not null
  ),
  componentes as materialized (
    select sc.kit_sku_id, sc.component_sku_id, sc.quantity
    from public.sku_components sc
    where sc.kit_sku_id in (select j.sku_id from skus_janela j)
  ),
  historico as materialized (
    select t.sku_id, t.desde, t.ate, t.new_cost
    from (
      select
        h.sku_id,
        h.changed_at as desde,
        lead(h.changed_at) over (partition by h.sku_id order by h.changed_at, h.id) as ate,
        h.new_cost
      from public.sku_cost_history h
      where h.sku_id in (
        select j.sku_id from skus_janela j
        union
        select c.component_sku_id from componentes c
      )
    ) t
    where t.desde < v_fim
      and (t.ate is null or t.ate > v_ini)
  ),
  custo_kit as materialized (
    select
      l.item_id,
      count(*) as componentes,
      case when count(*) > 0 and bool_and(v.custo_unitario is not null)
           then sum(v.custo_unitario * c.quantity) end as custo,
      case when bool_and(v.fonte = 'historico') then 'historico' else 'atual' end as fonte
    from linhas l
    join componentes c on c.kit_sku_id = l.sku_id
    join public.skus cs on cs.id = c.component_sku_id
    left join historico hc
      on hc.sku_id = cs.id
     and hc.desde <= l.date_created
     and (hc.ate is null or l.date_created < hc.ate)
    cross join lateral (
      select
        nullif(coalesce(hc.new_cost, cs.purchase_cost), 0) as custo_unitario,
        case
          when coalesce(hc.new_cost, 0) > 0 then 'historico'
          when coalesce(cs.purchase_cost, 0) > 0 then 'atual'
        end as fonte
    ) v
    group by l.item_id
  ),
  custo as (
    select
      l.item_id,
      case
        when s.kind = 'KIT' and k.componentes > 0 then k.custo
        else nullif(coalesce(hs.new_cost, s.purchase_cost), 0)
      end * l.quantity as custo
    from linhas l
    join public.skus s on s.id = l.sku_id
    left join historico hs
      on hs.sku_id = s.id
     and hs.desde <= l.date_created
     and (hs.ate is null or l.date_created < hs.ate)
    left join custo_kit k on k.item_id = l.item_id
  ),
  -- ── fim das CTEs de custo ──
  vendas as materialized (
    select
      l.anuncio || ':' || fx.faixa as chave,
      l.anuncio,
      fx.faixa,
      l.sku_id,
      l.ml_account_id,
      l.title,
      l.date_created,
      l.date_created >= v_corte as atual,
      l.preco,
      l.comissao,
      l.frete,
      c.custo,
      (l.comissao is not null and c.custo is not null) as coberto
    from linhas l
    left join custo c on c.item_id = l.item_id
    cross join lateral (
      select case
        when l.preco < 40 then 'ate_40'
        when l.preco < 79 then '40_79'
        when l.preco < 120 then '79_120'
        when l.preco < 200 then '120_200'
        when l.preco < 400 then '200_400'
        else 'acima_400'
      end as faixa
    ) fx
  ),
  por_janela as materialized (
    select
      v.chave,
      v.atual,
      max(v.anuncio) as anuncio,
      max(v.faixa) as faixa,
      mode() within group (order by v.sku_id) filter (where v.sku_id is not null) as sku_id,
      max(v.ml_account_id::text)::uuid as ml_account_id,
      max(v.title) as titulo,
      count(*) as n,
      percentile_cont(0.5) within group (order by v.frete) as frete_med,
      percentile_cont(0.5) within group (order by v.preco) as preco_med,
      sum(v.frete) as frete_soma,
      sum(v.preco) as receita,
      count(*) filter (where v.coberto) as n_cob,
      sum(v.preco) filter (where v.coberto) as receita_cob,
      sum(v.preco - v.comissao - v.frete - v.custo) filter (where v.coberto) as resultado_cob
    from vendas v
    group by v.chave, v.atual
  ),
  dispersao_antes as (
    select v.chave, percentile_cont(0.5) within group (order by abs(v.frete - j.frete_med)) as mad
    from vendas v
    join por_janela j on j.chave = v.chave and not j.atual
    where not v.atual
    group by v.chave
  ),
  anuncios as materialized (
    select
      a.chave,
      a.anuncio,
      coalesce(a.sku_id, b.sku_id) as sku_id,
      a.ml_account_id,
      a.titulo,
      s.sku,
      li.categoria,
      s.weight_g is not null as tem_peso,
      a.n as n_atual,
      a.frete_med as frete_atual,
      a.frete_soma as frete_soma_atual,
      a.preco_med as preco_atual,
      a.faixa,
      a.frete_soma / nullif(a.receita, 0) as frete_share_atual,
      a.n_cob as cob_atual,
      a.resultado_cob / nullif(a.receita_cob, 0) as margem_atual,
      coalesce(b.n, 0) as n_antes,
      b.frete_med as frete_antes,
      b.preco_med as preco_antes,
      b.frete_soma / nullif(b.receita, 0) as frete_share_antes,
      coalesce(b.n_cob, 0) as cob_antes,
      b.resultado_cob / nullif(b.receita_cob, 0) as margem_antes,
      d.mad as mad_antes
    from por_janela a
    left join por_janela b on b.chave = a.chave and not b.atual
    left join dispersao_antes d on d.chave = a.chave
    left join public.skus s on s.id = coalesce(a.sku_id, b.sku_id)
    left join lateral (
      select l.category_id as categoria
      from public.listings l
      where l.ml_account_id = a.ml_account_id
        and l.item_id = a.anuncio
    ) li on true
    where a.atual
      and a.n >= 3
  ),
  irmaos as (
    select a.chave, count(*) as n_irmaos,
           percentile_cont(0.5) within group (order by b.frete_atual) as frete_irmaos
    from anuncios a
    join anuncios b on b.sku_id = a.sku_id and b.faixa = a.faixa and b.anuncio <> a.anuncio
    group by a.chave
  ),
  -- Um valor por produto (a mediana dos seus anúncios na faixa): SKU com
  -- muitos anúncios não pesa mais que os outros no grupo. Anúncio sem SKU é
  -- o seu próprio produto.
  pares_sku as (
    select a.categoria, a.faixa, coalesce(a.sku_id::text, a.anuncio) as produto,
           percentile_cont(0.5) within group (order by a.frete_atual) as frete
    from anuncios a
    where a.categoria is not null
    group by a.categoria, a.faixa, coalesce(a.sku_id::text, a.anuncio)
  ),
  pares_grupo as (
    select p.categoria, p.faixa, count(*) as skus,
           percentile_cont(0.5) within group (order by p.frete) as mediana
    from pares_sku p
    group by p.categoria, p.faixa
    having count(*) >= 6
  ),
  pares as (
    select g.categoria, g.faixa, g.skus, g.mediana,
           percentile_cont(0.5) within group (order by abs(p.frete - g.mediana)) as mad
    from pares_grupo g
    join pares_sku p on p.categoria = g.categoria and p.faixa = g.faixa
    group by g.categoria, g.faixa, g.skus, g.mediana
  ),
  -- D-399: a mudança GERAL do frete em cada faixa = a mediana da variação dos
  -- anúncios que venderam nas duas janelas (frete de agora ÷ frete de antes).
  -- Se a tabela do Mercado Livre subiu 5%, a maioria dos anúncios mostra 1,05;
  -- o que é de um anúncio só fica fora da mediana. NÃO é a mediana de todos os
  -- pedidos: ela muda com a composição (medido: +24% na faixa de R$ 200 a 400
  -- porque passou a vender mais baú, contra +3,1% pelos anúncios). Com menos de
  -- 10 anúncios comparáveis na faixa, não há mudança medida (fator 1).
  fator as (
    select
      a.faixa,
      count(*) as anuncios_comparados,
      case
        when count(*) >= 10
        then percentile_cont(0.5) within group (order by a.frete_atual / a.frete_antes)
      end as fator_geral
    from anuncios a
    where a.n_antes >= 5
      and a.frete_antes > 0
    group by a.faixa
  ),
  faixas as (
    select a.faixa, count(*) as anuncios,
           percentile_cont(0.5) within group (order by a.frete_atual / nullif(a.preco_atual, 0)) as razao_mediana,
           percentile_cont(0.95) within group (order by a.frete_atual / nullif(a.preco_atual, 0)) as razao_p95
    from anuncios a
    group by a.faixa
  ),
  medidas as (
    select
      a.*,
      i.n_irmaos,
      i.frete_irmaos,
      p.skus as n_pares,
      p.mediana as frete_pares,
      f.razao_p95,
      fg.fator_geral,
      a.frete_antes * coalesce(fg.fator_geral, 1) as frete_esperado,
      a.frete_atual / nullif(a.preco_atual, 0) as razao,
      greatest(0.15, 3 * coalesce(a.mad_antes, 0) / nullif(a.frete_antes, 0)) as limiar_historico,
      a.frete_atual / nullif(a.frete_antes * coalesce(fg.fator_geral, 1), 0) - 1 as var_historico,
      a.frete_atual / nullif(i.frete_irmaos, 0) - 1 as var_irmaos,
      a.frete_atual / nullif(p.mediana, 0) - 1 as var_pares,
      case
        when p.mad is null then null
        when p.mad > 0 then (a.frete_atual - p.mediana) / (1.4826 * p.mad)
        when a.frete_atual > p.mediana then 99
        else 0
      end as z_pares
    from anuncios a
    left join irmaos i on i.chave = a.chave
    left join pares p on p.categoria = a.categoria and p.faixa = a.faixa
    left join faixas f on f.faixa = a.faixa
    left join fator fg on fg.faixa = a.faixa
  ),
  pontos as (
    select
      m.*,
      case
        when m.n_antes >= 5 and m.frete_antes > 0
             and m.frete_atual - m.frete_esperado >= 1 then
          case
            when m.var_historico >= greatest(0.80, m.limiar_historico) then 3
            when m.var_historico >= greatest(0.40, m.limiar_historico) then 2
            when m.var_historico >= m.limiar_historico then 1
            else 0
          end
        else 0
      end as p_historico,
      case
        when m.frete_irmaos > 0 and m.frete_atual - m.frete_irmaos >= 1 then
          case
            when m.var_irmaos >= 0.80 then 3
            when m.var_irmaos >= 0.40 then 2
            when m.var_irmaos >= 0.15 then 1
            else 0
          end
        else 0
      end as p_irmaos,
      case
        when m.frete_pares > 0 and m.frete_atual - m.frete_pares >= 2 then
          case
            when m.var_pares >= 2.00 and m.z_pares >= 6 then 3
            when m.var_pares >= 1.00 and m.z_pares >= 4 then 2
            when m.var_pares >= 0.50 and m.z_pares >= 3 then 1
            else 0
          end
        else 0
      end as p_pares,
      case
        when m.razao >= greatest(2 * m.razao_p95, 0.40) then 3
        when m.razao >= greatest(1.5 * m.razao_p95, 0.30) then 2
        when m.razao > m.razao_p95 and m.razao >= 0.25 then 1
        else 0
      end as p_proporcao,
      (m.cob_antes >= 5 and m.cob_atual >= 3 and m.margem_antes > 0 and m.margem_atual <= 0
        and m.frete_share_atual - m.frete_share_antes >= (m.margem_antes - m.margem_atual) / 2) as deixou_de_ser_rentavel,
      (m.cob_atual >= 3 and m.margem_atual < 0 and m.frete_share_atual >= 0.10) as prejuizo,
      case when m.n_antes >= 5 then m.frete_share_antes - m.frete_share_atual end as impacto_frete,
      -- O frete tirou 5 p.p. do preço E a margem caiu junto (quando ela é
      -- conhecida nas duas janelas): se o preço ou o custo compensaram, dizer
      -- que o frete "tirou margem" seria falso.
      (m.n_antes >= 5 and m.frete_share_atual - m.frete_share_antes >= 0.05
        and (m.cob_antes < 5 or m.cob_atual < 3 or m.margem_antes - m.margem_atual >= 0.05)) as frete_tirou_margem
    from medidas m
  ),
  pontuado as (
    select
      q.*,
      case
        when q.deixou_de_ser_rentavel then 2
        else least(2, (case when q.prejuizo then 1 else 0 end)
                      + (case when q.frete_tirou_margem then 1 else 0 end))
      end as p_margem
    from pontos q
  ),
  classificado as materialized (
    select
      z.*,
      z.p_historico + z.p_irmaos + z.p_pares + z.p_proporcao + z.p_margem as total,
      case
        when z.p_historico + z.p_irmaos + z.p_pares + z.p_proporcao + z.p_margem >= 5 then 'forte'
        when z.p_historico + z.p_irmaos + z.p_pares + z.p_proporcao + z.p_margem >= 3 then 'provavel'
        when z.p_historico + z.p_irmaos + z.p_pares + z.p_proporcao + z.p_margem >= 1 then 'atencao'
        else 'normal'
      end as nivel,
      -- A referência do "frete a mais": a comparação mais direta que pontuou.
      case
        when z.p_historico > 0 then z.frete_esperado
        when z.p_irmaos > 0 then z.frete_irmaos
        when z.p_pares > 0 then z.frete_pares
      end as referencia
    from pontuado z
  ),
  -- Quando o frete do anúncio subiu: o primeiro pedido depois do último que
  -- ainda pagava o frete de antes. Só para quem pontuou no histórico.
  ultimo_frete_antigo as (
    select c.chave, max(v.date_created) as em
    from classificado c
    join vendas v on v.chave = c.chave
    where c.p_historico > 0
      and v.frete <= c.frete_antes * (1 + c.limiar_historico / 2)
    group by c.chave
  ),
  mudanca as (
    select u.chave, min(v.date_created) as desde
    from ultimo_frete_antigo u
    join vendas v on v.chave = u.chave and v.date_created > u.em
    group by u.chave
  )
  select jsonb_build_object(
    'janela', jsonb_build_object(
      'inicio', v_hoje - 90,
      'corte', v_hoje - 14,
      'fim', v_hoje - 1
    ),
    'resumo', (
      select jsonb_build_object(
        'analisados', count(*),
        'anuncios', count(distinct c.anuncio),
        'com_historico', count(*) filter (where c.n_antes >= 5),
        'com_irmaos', count(*) filter (where c.frete_irmaos is not null),
        'com_pares', count(*) filter (where c.frete_pares is not null),
        'normal', count(*) filter (where c.nivel = 'normal'),
        'atencao', count(*) filter (where c.nivel = 'atencao'),
        'provavel', count(*) filter (where c.nivel = 'provavel'),
        'forte', count(*) filter (where c.nivel = 'forte'),
        'excesso_14_dias', round((sum(c.frete_soma_atual - c.referencia * c.n_atual)
                                 filter (where c.nivel in ('provavel', 'forte') and c.referencia is not null))::numeric, 2),
        'skus', count(distinct c.sku_id),
        'skus_com_peso', count(distinct c.sku_id) filter (where c.tem_peso)
      )
      from classificado c
    ),
    'faixas', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'faixa', f.faixa,
        'anuncios', f.anuncios,
        'razao_mediana', round(f.razao_mediana::numeric, 4),
        'razao_p95', round(f.razao_p95::numeric, 4),
        'anuncios_comparados', coalesce(fg.anuncios_comparados, 0),
        'variacao_geral', round((fg.fator_geral - 1)::numeric, 4)
      ) order by f.faixa), '[]'::jsonb)
      from faixas f
      left join fator fg on fg.faixa = f.faixa
    ),
    'alertas', (
      select coalesce(jsonb_agg(x.j order by x.total desc, x.excesso desc nulls last, x.chave), '[]'::jsonb)
      from (
        select
          c.total,
          c.chave,
          round((c.frete_soma_atual - c.referencia * c.n_atual)::numeric, 2) as excesso,
          jsonb_build_object(
            'anuncio', c.anuncio,
            'sku_id', c.sku_id,
            'sku', c.sku,
            'titulo', c.titulo,
            'conta', a.label,
            'categoria', c.categoria,
            'nivel', c.nivel,
            'pontos', c.total,
            'faixa', c.faixa,
            'pedidos_atual', c.n_atual,
            'pedidos_antes', c.n_antes,
            'frete_atual', round(c.frete_atual::numeric, 2),
            'frete_antes', round(c.frete_antes::numeric, 2),
            'frete_esperado', round(c.frete_esperado::numeric, 2),
            'variacao_geral_faixa', round((c.fator_geral - 1)::numeric, 4),
            'preco_atual', round(c.preco_atual::numeric, 2),
            'preco_antes', round(c.preco_antes::numeric, 2),
            'razao', round(c.razao::numeric, 4),
            'razao_p95', round(c.razao_p95::numeric, 4),
            'frete_irmaos', round(c.frete_irmaos::numeric, 2),
            'irmaos', c.n_irmaos,
            'frete_pares', round(c.frete_pares::numeric, 2),
            'pares', c.n_pares,
            'z_pares', round(least(c.z_pares, 99)::numeric, 1),
            'margem_atual', round(c.margem_atual::numeric, 4),
            'margem_antes', round(c.margem_antes::numeric, 4),
            'cobertos_atual', c.cob_atual,
            'cobertos_antes', c.cob_antes,
            'frete_share_atual', round(c.frete_share_atual::numeric, 4),
            'frete_share_antes', round(c.frete_share_antes::numeric, 4),
            'impacto_frete', round(c.impacto_frete::numeric, 4),
            'excesso', round((c.frete_soma_atual - c.referencia * c.n_atual)::numeric, 2),
            'mudou_em', (m.desde at time zone 'America/Sao_Paulo')::date,
            'sinais', jsonb_build_object(
              'historico', c.p_historico,
              'irmaos', c.p_irmaos,
              'pares', c.p_pares,
              'proporcao', c.p_proporcao,
              'margem', c.p_margem,
              'deixou_de_ser_rentavel', c.deixou_de_ser_rentavel,
              'prejuizo', c.prejuizo,
              'frete_tirou_margem', c.frete_tirou_margem
            )
          ) as j
        from classificado c
        join public.ml_accounts a on a.id = c.ml_account_id
        left join mudanca m on m.chave = c.chave
        where c.total > 0
          -- D-631 b: nao ha frete a corrigir num anuncio excluido. Ele segue
          -- na comparacao com os irmaos (vendeu na janela); so nao vira alerta.
          and not exists (
            select 1 from public.listings d
            where d.ml_account_id = c.ml_account_id and d.item_id = c.anuncio and d.deleted_at is not null
          )
        order by c.total desc, (c.frete_soma_atual - c.referencia * c.n_atual) desc nulls last, c.chave
        limit 200
      ) x
    )
  )
  );
end;
$function$;
