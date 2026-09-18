-- ============================================================
-- `/anuncios`: ordenar pela coluna que a pessoa escolhe, contar a faixa numa
-- consulta so, e trazer a foto e o link do anuncio no Mercado Livre.
--
-- ------------------------------------------------------------
-- 1. A FAIXA CUSTAVA SEIS VEZES A LISTA
-- ------------------------------------------------------------
--
-- A tela chamava `get_listings_dashboard` sete vezes por visita: a pagina e
-- mais seis com `p_limit = 1` so para ler o `total_count` de cada celula
-- (D-224: celula e lista saindo do MESMO predicado). Cada chamada agrega
-- venda, visitas e conversao da janela inteira -- que as contagens nao usam.
--
-- Medido em PRODUCAO (imvjfgna...), 2026-09-18, como `authenticated` real
-- (ADMIN, 4 contas, 4.447 anuncios, 30 dias):
--
--   lista, 50 linhas                     146 ms
--   so a contagem (p_limit 1)            129 ms
--   so a contagem, sem vinculo           107 ms
--
-- Seis contagens ~ 0,7 s de banco por visita, para seis numeros.
--
-- `get_listings_dashboard_counts` conta as seis celulas NUMA passada, sem os
-- CTEs de venda e de visitas: nenhuma celula depende da janela. O predicado
-- de cada celula e COPIADO do da lista, linha por linha, e o teste de
-- integracao `contagens da faixa = total_count da lista` (rls.integration)
-- prende os dois: se um mudar sem o outro, a CI reprova. E a protecao que
-- D-224 pedia, trocada de "mesma funcao" para "mesmo resultado, provado".
--
-- ------------------------------------------------------------
-- 2. ORDENAR
-- ------------------------------------------------------------
--
-- A ordem era fixa em faturamento. Com 4.447 anuncios em 89 paginas, a
-- pergunta "quais tem mais visita e converte pouco" ou "quais estao com
-- estoque zerado e vendem" nao tinha como ser feita. `p_order` aceita uma
-- lista FECHADA (`<coluna>_<asc|desc>`); qualquer outro valor cai no padrao,
-- `revenue_desc` -- a ordem de antes, para os cinco consumidores que nao
-- passam o parametro. Nulo (visita sem coleta, Full sem snapshot, conversao
-- indefinida) vai sempre para o FIM, nas duas direcoes: ordenar ausencia de
-- dado junto com zero seria afirmar que ela e zero (D-067).
--
-- ------------------------------------------------------------
-- 3. FOTO E LINK
-- ------------------------------------------------------------
--
-- `listings.thumbnail_url` e `listings.permalink`, NULOS ate a proxima
-- sincronizacao do catalogo (a cada 6 h; `ml-listings-fetch` passa a pedir os
-- dois campos no multiget). Nulo nao e erro: a tela mostra o monograma, como
-- sempre mostrou.
--
-- O resto da funcao e o corpo de 20260910220000 sem alteracao -- plpgsql +
-- `force_custom_plan` (D-305), `security invoker`, `search_path = ''`.
-- Mudar o `returns table` exige derrubar e recriar; os cinco consumidores
-- leem colunas por NOME e nao passam `p_order`, entao nao mudam.
-- ============================================================

alter table public.listings
  add column if not exists thumbnail_url text,
  add column if not exists permalink text;

comment on column public.listings.thumbnail_url is
  'Miniatura do anuncio no Mercado Livre (`secure_thumbnail` do item). NULA ate a proxima sincronizacao do catalogo.';
comment on column public.listings.permalink is
  'Endereco publico do anuncio no Mercado Livre. NULO ate a proxima sincronizacao do catalogo.';

drop function if exists public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text);

create function public.get_listings_dashboard(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_status text default null,
  p_link_state text default 'all',
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_stock text default 'all',
  p_full text default 'all',
  p_sold text default 'all',
  p_order text default 'revenue_desc'
)
returns table (
  listing_id uuid,
  item_id text,
  title text,
  status text,
  price numeric,
  available_quantity integer,
  synced_at timestamptz,
  ml_account_id uuid,
  account_label text,
  sku_id uuid,
  sku text,
  link_state text,
  units_sold bigint,
  gross_revenue numeric,
  visits numeric,
  days_observed integer,
  conversion_rate numeric,
  full_quantity numeric,
  thumbnail_url text,
  permalink text,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
begin
  return query
  with metricas_dia as (
    select m.ml_account_id, m.mlb_id, m.metric_date,
           sum(m.units_sold)    as units_sold,
           sum(m.gross_revenue) as gross_revenue,
           sum(m.orders_count)  as orders_count
    from public.daily_listing_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date between p_date_from and p_date_to
    group by m.ml_account_id, m.mlb_id, m.metric_date
  ),
  metricas as (
    select d.ml_account_id, d.mlb_id,
           sum(d.units_sold)::bigint as units_sold,
           sum(d.gross_revenue)      as gross_revenue
    from metricas_dia d
    group by d.ml_account_id, d.mlb_id
  ),
  visitas as (
    select v.ml_account_id, v.item_id,
           sum(v.visits) as visits,
           count(*)::integer as days_observed,
           sum(coalesce(md.orders_count, 0)) as orders_observed
    from public.daily_listing_visits v
    left join metricas_dia md
      on md.ml_account_id = v.ml_account_id
     and md.mlb_id = v.item_id
     and md.metric_date = v.metric_date
    where v.organization_id = p_organization_id
      and v.metric_date between p_date_from and p_date_to
    group by v.ml_account_id, v.item_id
  ),
  vinculos as (
    select distinct k.ml_account_id, k.item_id
    from public.sku_listing_links k
    where k.organization_id = p_organization_id
  ),
  full_ultimo as (
    -- A DEFINICAO CANONICA de Full (D-173/D-204), a mesma de `get_sku_dashboard`
    -- e `get_fulfillment_overview`: o ultimo snapshot por (conta, inventory_id)
    -- -- o bucket que o Mercado Livre reparte --, e so dos ultimos 3 dias.
    select distinct on (f.ml_account_id, f.inventory_id)
           f.ml_account_id, f.item_id, f.quantity
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
      and f.captured_at >= now() - interval '3 days'
    order by f.ml_account_id, f.inventory_id, f.captured_at desc
  ),
  full_por_anuncio as (
    select u.ml_account_id, u.item_id, sum(u.quantity) as full_quantity
    from full_ultimo u
    group by u.ml_account_id, u.item_id
  ),
  base as (
    select
      l.id as listing_id, l.item_id, l.title, l.status, l.price,
      l.available_quantity, l.synced_at, l.ml_account_id,
      a.label as account_label, l.sku_id, s.sku,
      case when l.sku_id is not null   then 'linked'
           when kv.item_id is not null then 'linked_variation'
           else 'unlinked' end as link_state,
      coalesce(md.units_sold, 0)::bigint as units_sold,
      coalesce(md.gross_revenue, 0) as gross_revenue,
      vs.visits,
      coalesce(vs.days_observed, 0) as days_observed,
      round(vs.orders_observed::numeric / nullif(vs.visits, 0), 4) as conversion_rate,
      -- NULA sem snapshot: ausencia de dado nao e zero (D-067).
      fa.full_quantity,
      l.thumbnail_url,
      l.permalink
    from public.listings l
    join public.ml_accounts a on a.id = l.ml_account_id
    left join public.skus s on s.id = l.sku_id
    left join metricas md on md.ml_account_id = l.ml_account_id and md.mlb_id = l.item_id
    left join visitas  vs on vs.ml_account_id = l.ml_account_id and vs.item_id = l.item_id
    left join vinculos kv on kv.ml_account_id = l.ml_account_id and kv.item_id = l.item_id
    left join full_por_anuncio fa on fa.ml_account_id = l.ml_account_id and fa.item_id = l.item_id
    where l.organization_id = p_organization_id
      and (p_ml_account_id is null or l.ml_account_id = p_ml_account_id)
      and (p_status is null or l.status = p_status)
      and case p_stock
            when 'out' then l.available_quantity = 0
            when 'in'  then l.available_quantity > 0
            else true
          end
      and case p_full
            when 'with'    then coalesce(fa.full_quantity, 0) > 0
            when 'without' then coalesce(fa.full_quantity, 0) = 0
            else true
          end
      /*
        VENDA na janela. `md.units_sold` vem de `metricas`, agregada entre
        `p_date_from` e `p_date_to` -- entao "vendido" quer dizer "vendeu no
        periodo pedido", nunca "ja vendeu algum dia". Sem metrica a linha nao
        existe em `md`, e o `coalesce` a trata como zero: aqui isso e correto,
        porque ausencia de metrica de venda E ausencia de venda (diferente do
        Full, onde ausencia de snapshot nao e estoque zero -- D-067).
      */
      and case p_sold
            when 'with'    then coalesce(md.units_sold, 0) > 0
            when 'without' then coalesce(md.units_sold, 0) = 0
            else true
          end
      and (p_search is null
           or l.item_id ilike '%' || p_search || '%'
           or l.title   ilike '%' || p_search || '%'
           or s.sku     ilike '%' || p_search || '%')
  ),
  filtrado as (
    select * from base
    -- `base.link_state` QUALIFICADO: em plpgsql, `link_state` sozinho colide
    -- com a coluna de saida homonima de `returns table` (D-305).
    where case p_link_state
            when 'linked'   then base.link_state in ('linked', 'linked_variation')
            when 'unlinked' then base.link_state = 'unlinked'
            else true
          end
  )
  select f.listing_id, f.item_id, f.title, f.status, f.price, f.available_quantity,
         f.synced_at, f.ml_account_id, f.account_label, f.sku_id, f.sku, f.link_state,
         f.units_sold, f.gross_revenue, f.visits, f.days_observed, f.conversion_rate,
         f.full_quantity, f.thumbnail_url, f.permalink,
         count(*) over () as total_count
  from filtrado f
  -- Uma chave por par de linhas: so a do `p_order` pedido e nao nula, as outras
  -- viram NULL e empatam. Valor fora da lista cai em `revenue_desc` (o `else`
  -- da primeira chave). `nulls last` nas duas direcoes: ausencia de dado vai
  -- para o fim, nunca se mistura com o zero (D-067).
  order by
    case when p_order = 'revenue_asc'    then f.gross_revenue end asc  nulls last,
    case when p_order not in ('revenue_asc', 'units_desc', 'units_asc', 'visits_desc', 'visits_asc',
                              'conversion_desc', 'conversion_asc', 'price_desc', 'price_asc',
                              'stock_desc', 'stock_asc', 'full_desc', 'full_asc',
                              'title_asc', 'title_desc', 'synced_desc', 'synced_asc')
         or p_order is null                then f.gross_revenue end desc nulls last,
    case when p_order = 'units_desc'      then f.units_sold end desc nulls last,
    case when p_order = 'units_asc'       then f.units_sold end asc  nulls last,
    case when p_order = 'visits_desc'     then f.visits end desc nulls last,
    case when p_order = 'visits_asc'      then f.visits end asc  nulls last,
    case when p_order = 'conversion_desc' then f.conversion_rate end desc nulls last,
    case when p_order = 'conversion_asc'  then f.conversion_rate end asc  nulls last,
    case when p_order = 'price_desc'      then f.price end desc nulls last,
    case when p_order = 'price_asc'       then f.price end asc  nulls last,
    case when p_order = 'stock_desc'      then f.available_quantity end desc nulls last,
    case when p_order = 'stock_asc'       then f.available_quantity end asc  nulls last,
    case when p_order = 'full_desc'       then f.full_quantity end desc nulls last,
    case when p_order = 'full_asc'        then f.full_quantity end asc  nulls last,
    case when p_order = 'title_desc'      then f.title end desc nulls last,
    case when p_order = 'synced_desc'     then f.synced_at end desc nulls last,
    case when p_order = 'synced_asc'      then f.synced_at end asc  nulls last,
    -- Desempate estavel: sem ele, duas paginas seguidas podem repetir ou
    -- pular um anuncio de mesmo valor.
    f.title asc, f.item_id asc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0);
end;
$$;

comment on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text, text) is
  'Dashboard de /anuncios (D-138), com Full por anuncio (D-243), venda na janela (D-259), ordem escolhida (p_order, lista fechada, padrao revenue_desc) e foto/link do ML. p_link_state NAO e sku_id is null: anuncios tem vinculo POR VARIACAO (D-122). As celulas da faixa saem de get_listings_dashboard_counts, com o predicado copiado deste e preso por teste de integracao. plpgsql + force_custom_plan desde D-305. security invoker.';

revoke all on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text, text) from public, anon;
grant execute on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- As seis celulas da faixa, numa passada.
-- ------------------------------------------------------------
create function public.get_listings_dashboard_counts(
  p_organization_id uuid,
  p_ml_account_id uuid default null,
  p_search text default null
)
returns table (
  total bigint,
  active bigint,
  paused bigint,
  out_of_stock bigint,
  in_full bigint,
  unlinked bigint
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
begin
  return query
  with vinculos as (
    select distinct k.ml_account_id, k.item_id
    from public.sku_listing_links k
    where k.organization_id = p_organization_id
  ),
  full_ultimo as (
    -- A mesma definicao canonica de Full de `get_listings_dashboard` (D-173/D-204).
    select distinct on (f.ml_account_id, f.inventory_id)
           f.ml_account_id, f.item_id, f.quantity
    from public.fulfillment_stock_snapshots f
    where f.organization_id = p_organization_id
      and f.captured_at >= now() - interval '3 days'
    order by f.ml_account_id, f.inventory_id, f.captured_at desc
  ),
  full_por_anuncio as (
    select u.ml_account_id, u.item_id, sum(u.quantity) as full_quantity
    from full_ultimo u
    group by u.ml_account_id, u.item_id
  ),
  escopo as (
    -- O ESCOPO da faixa e conta + busca, sem filtro de estado: cada celula E
    -- um filtro de estado (mesmo raciocinio da tela desde D-242).
    select l.status, l.available_quantity, l.sku_id, kv.item_id as vinculo_por_variacao,
           fa.full_quantity
    from public.listings l
    join public.ml_accounts a on a.id = l.ml_account_id
    left join public.skus s on s.id = l.sku_id
    left join vinculos kv on kv.ml_account_id = l.ml_account_id and kv.item_id = l.item_id
    left join full_por_anuncio fa on fa.ml_account_id = l.ml_account_id and fa.item_id = l.item_id
    where l.organization_id = p_organization_id
      and (p_ml_account_id is null or l.ml_account_id = p_ml_account_id)
      and (p_search is null
           or l.item_id ilike '%' || p_search || '%'
           or l.title   ilike '%' || p_search || '%'
           or s.sku     ilike '%' || p_search || '%')
  )
  select
    count(*),
    count(*) filter (where e.status = 'active'),
    count(*) filter (where e.status = 'paused'),
    -- = p_stock 'out'
    count(*) filter (where e.available_quantity = 0),
    -- = p_full 'with'
    count(*) filter (where coalesce(e.full_quantity, 0) > 0),
    -- = p_link_state 'unlinked': nem por anuncio nem por variacao (D-122)
    count(*) filter (where e.sku_id is null and e.vinculo_por_variacao is null)
  from escopo e;
end;
$$;

comment on function public.get_listings_dashboard_counts(uuid, uuid, text) is
  'As seis celulas da faixa de /anuncios (total, ativos, pausados, sem estoque, no Full, sem vinculo) numa passada, sem os CTEs de venda e visitas. Cada predicado e copia do de get_listings_dashboard; o teste de integracao compara as duas. security invoker.';

revoke all on function public.get_listings_dashboard_counts(uuid, uuid, text) from public, anon;
grant execute on function public.get_listings_dashboard_counts(uuid, uuid, text) to authenticated, service_role;
