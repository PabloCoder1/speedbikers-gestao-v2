-- ============================================================
-- D-373 -- `get_products_overview`: /produtos numa leitura, com as categorias.
--
-- O pedido do dono: "a tela de produtos ainda esta feia ... deixe ela bonita,
-- rapida e com bastante qualidade, tambem acho que cabe mais opcoes/categorias
-- ali". A tela lia duas RPCs (`get_sku_curation` e `get_sku_curation_summary`)
-- e so oferecia recortes de CURADORIA (estado, sinal, "sem marca"). O catalogo
-- tem mais eixos que nenhuma tela mostrava:
--
--   categoria   `skus.brand` -- a CATEGORIA do UpSeller (D-129: nunca "marca")
--   marca       `skus.supplier_brand` -- agora com as marcas de verdade, nao so
--               "sem marca"
--   tipo        `skus.kind` (PRODUTO | KIT)
--   situacao    `is_active` e `is_discontinued` ("ESTOQUE INATIVO" do ERP e
--               produto em encerramento, D-039)
--   anuncios    com / sem anuncio que venda o SKU (a definicao de D-122)
--   vendas      com / sem venda em 90 dias
--
-- Esta funcao devolve, num `jsonb`: a pagina (os campos de `get_sku_curation`
-- mais tipo, situacao, preco e custo), o total filtrado, as CONTAGENS de cada
-- eixo e o RESUMO do catalogo inteiro.
--
-- ------------------------------------------------------------
-- CONTAGENS FACETADAS
-- ------------------------------------------------------------
-- A contagem de um eixo respeita todos os OUTROS filtros e ignora o proprio:
-- com "Categoria = MANETE" ativa, o menu de categoria continua mostrando
-- quantos ha em cada uma (para trocar), e o de marca mostra so as marcas
-- DENTRO de MANETE. Cada linha carrega um booleano por eixo (`ok_*`), e cada
-- contagem e um `count(*) filter` sobre a conjuncao dos outros.
--
-- ------------------------------------------------------------
-- CUSTO
-- ------------------------------------------------------------
-- O custo de `get_sku_curation` ja era varrer o catalogo inteiro (o
-- `count(*) over ()`, D-315 secao 5); as contagens sao agregacoes sobre a MESMA
-- CTE materializada, sem nova leitura de tabela. Catalogo de ~2,3 mil SKUs.
-- `plan_cache_mode = force_custom_plan` pelo mesmo motivo de D-319.
--
-- ------------------------------------------------------------
-- O QUE NAO MUDA
-- ------------------------------------------------------------
-- - a assinatura sentinela, a divergencia, as vendas de 90 dias, o retrato do
--   ERP e a contagem de anuncios sao as de `get_sku_curation` (D-133/D-245);
-- - a ordem (curadoria | atualizado | criado) e o desempate por `sku` (D-315);
-- - `security definer` com a guarda da curadoria: so ADMIN/GESTOR -- mas pela
--   juncao de `private.has_org_role` (D-180), e nao pelo par
--   `is_member_of` + `has_role` de `check_sku_curation_writer`;
-- - `get_sku_curation` e `get_sku_curation_summary` continuam: a web cai nelas
--   quando esta funcao ainda nao chegou ao banco (PGRST202).
-- - origem fiscal (`is_imported`) continua FORA (D-129/D-139).
-- ============================================================

create function public.get_products_overview(
  p_organization_id uuid,
  p_classified text default null,
  p_signal text default null,
  p_brand text default null,
  p_missing_brand boolean default false,
  p_category text default null,
  p_missing_category boolean default false,
  p_kind text default null,
  p_status text default null,
  p_listing text default null,
  p_sales text default null,
  p_search text default null,
  p_order text default 'curadoria',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  resultado jsonb;
  busca text := nullif(pg_catalog.btrim(coalesce(p_search, '')), '');
begin
  if not private.has_org_role(p_organization_id, array['ADMIN', 'GESTOR']) then
    raise exception 'sem permissao para curar o catalogo desta organizacao';
  end if;

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
      union
      select k.sku_id, k.ml_account_id, k.item_id
      from public.sku_listing_links k
      where k.organization_id = p_organization_id and k.ref_kind = 'ITEM' and k.item_id is not null
    ) u
    group by u.sku_id
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
      coalesce(an.listing_count, 0)::bigint as listing_count
    from public.skus k
    left join retrato_agg ra on ra.sku_id = k.id
    left join vendas v on v.sku_id = k.id
    left join anuncios an on an.sku_id = k.id
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
      (p_listing is null
        or (p_listing = 'COM' and m.listing_count > 0)
        or (p_listing = 'SEM' and m.listing_count = 0)) as ok_anuncios,
      (p_sales is null
        or (p_sales = 'COM' and m.units_sold_90d > 0)
        or (p_sales = 'SEM' and m.units_sold_90d = 0)) as ok_vendas,
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
          'com', count(*) filter (where c.listing_count > 0),
          'sem', count(*) filter (where c.listing_count = 0))
        from com_sinal c
        where c.ok_estado and c.ok_sinal and c.ok_marca and c.ok_categoria
          and c.ok_tipo and c.ok_situacao and c.ok_vendas and c.ok_busca),
      'vendas', (
        select jsonb_build_object(
          'todos', count(*),
          'com', count(*) filter (where c.units_sold_90d > 0),
          'sem', count(*) filter (where c.units_sold_90d = 0))
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
        'sem_anuncio', count(*) filter (where e.listing_count = 0 and e.is_active),
        'sem_venda_90d', count(*) filter (where e.units_sold_90d = 0 and e.is_active),
        'encerrando', count(*) filter (where e.situacao = 'ENCERRANDO'),
        'retrato_em', max(e.snapshot_captured_at))
      from eixos e)
  )
  into resultado;

  return resultado;
end;
$$;

comment on function public.get_products_overview(uuid, text, text, text, boolean, text, boolean, text, text, text, text, text, text, integer, integer) is
  '/produtos numa leitura (D-373): pagina com os campos de get_sku_curation mais tipo, situacao (ATIVO | ENCERRANDO | INATIVO), preco e custo; total filtrado; contagens FACETADAS por eixo (estado, sinal, marca, categoria, tipo, situacao, anuncios, vendas), cada uma com os outros filtros e sem o proprio; resumo do catalogo inteiro. Mesma assinatura sentinela, divergencia, retrato, vendas 90d e anuncios (D-122) de get_sku_curation; mesma ordem e desempate (D-315). SECURITY DEFINER, ADMIN/GESTOR por has_org_role (D-180). force_custom_plan (D-319).';

revoke all on function public.get_products_overview(uuid, text, text, text, boolean, text, boolean, text, text, text, text, text, text, integer, integer) from public, anon;
grant execute on function public.get_products_overview(uuid, text, text, text, boolean, text, boolean, text, text, text, text, text, text, integer, integer) to authenticated, service_role;
