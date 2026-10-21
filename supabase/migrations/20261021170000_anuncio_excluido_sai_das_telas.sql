-- ============================================================
-- D-631 -- o anuncio excluido no Mercado Livre sai das telas.
--
-- Pedido do dono (21/10): anuncios apagados na conta SbMotos continuavam no
-- sistema. A varredura do catalogo (`/users/{id}/items/search`) nao devolve o
-- anuncio excluido, e a V3 so gravava o que a varredura devolvia: a linha
-- ficava com o ultimo status visto (ate "ativo") para sempre.
--
-- O Mercado Livre marca a exclusao como status `closed` com o subestado
-- `deleted` (`sub_status`, lista; documentacao oficial "Sincronizacao e
-- modificacao de publicacoes", lida em 21/10), e "depois de um tempo, os
-- itens finalizados nao serao mais mostrados para sua consulta" (o 404).
--
-- `listings` ganha `sub_status` e `deleted_at` (quando a V3 viu a exclusao).
-- A linha fica, porque e historico de venda e de vinculo; a lista e a faixa
-- de /anuncios, os anuncios do SKU e a visao de vinculos deixam de mostra-la.
-- Os corpos sao os atuais (20261021160000, 20260921121405, 20260917220000),
-- com a mesma assinatura e o mesmo retorno.
-- ============================================================

alter table public.listings
  add column if not exists sub_status text[],
  add column if not exists deleted_at timestamptz;

comment on column public.listings.sub_status is
  'O subestado do anuncio no Mercado Livre (`sub_status`, lista: out_of_stock, deleted...) na ultima leitura boa (D-631). NULO = ainda nao lido.';
comment on column public.listings.deleted_at is
  'Quando a V3 viu o anuncio excluido no Mercado Livre (D-631): status closed com sub_status deleted, ou 404 na leitura do item. A linha fica (historico); as telas do catalogo a escondem.';

create or replace function public.get_listings_dashboard(
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
  p_order text default 'revenue_desc',
  p_promo text default 'all',
  p_preco text default 'all',
  p_preco_teto numeric default null,
  p_queda text default 'all'
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
  -- D-419: NULO = promocao nao lida (so anuncio ativo e lido).
  in_promotion boolean,
  promotional_price numeric,
  promotion_checked_at timestamptz,
  total_count bigint,
  -- Somas do RECORTE inteiro (filtrado, antes do limit), repetidas em toda
  -- linha como `total_count`. Nulas so quando o recorte e vazio.
  recorte_faturamento numeric,
  recorte_unidades bigint,
  recorte_visitas numeric,
  recorte_pedidos_observados numeric,
  -- C-77 (D-625): o preco ao comprador desta linha, e a dispersao do SKU
  -- entre os anuncios ativos e pausados dele. NULAS sem SKU, ou com um
  -- preco so no SKU.
  preco_efetivo numeric,
  sku_preco_min numeric,
  sku_preco_max numeric,
  sku_anuncios_com_preco integer,
  sku_dispersao_pct numeric,
  sku_dispersao_sku_id uuid,
  -- C-79 (D-629): a queda nas vendas do anuncio no periodo da tela, quando
  -- ele termina hoje -- calculada sobre os dias fechados ate ontem. NULAS em
  -- outro periodo, ou antes do primeiro calculo.
  queda_estado text,
  queda_z numeric,
  queda_calculada_em timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  -- C-79: a queda se le pelo numero de dias do periodo, so quando ele termina
  -- hoje (a /anuncios usa os ultimos N dias); o calculo e dos N fechados ate ontem.
  v_queda_dias integer := case
    when p_date_to = (now() at time zone 'America/Sao_Paulo')::date then p_date_to - p_date_from + 1
  end;
begin
  -- C-77: o teto vem da web (TETO_DISPERSAO_PCT), num lugar so; sem ele o
  -- filtro nao tem regua, e e recusado em vez de cair num numero inventado.
  if p_preco = 'divergente' and (p_preco_teto is null or p_preco_teto < 0) then
    raise exception 'p_preco divergente exige p_preco_teto >= 0';
  end if;

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
  -- C-77 (D-625): o conjunto de anuncios de um SKU e o de get_sku_listings
  -- (D-122): listings.sku_id uniao o vinculo ITEM, inclusive o por variacao
  -- (o preco e o do ITEM). So ATIVO ou PAUSADO -- o encerrado fica fora, a
  -- decisao do A2/A3 de 21/10, a mesma do diagnostico do SKU (D-630).
  anuncio_sku as (
    select l.sku_id, l.ml_account_id, l.item_id
    from public.listings l
    where l.organization_id = p_organization_id
      and l.sku_id is not null
    union
    select k.sku_id, k.ml_account_id, k.item_id
    from public.sku_listing_links k
    where k.organization_id = p_organization_id
      and k.ref_kind = 'ITEM'
      and k.item_id is not null
  ),
  -- O preco que chega ao comprador: o promocional, senao o cadastrado
  -- (D-389), o mesmo `precoEfetivo` do diagnostico do SKU.
  preco_sku as (
    select x.sku_id,
           min(coalesce(pl.promotional_price, pl.price)) as preco_minimo,
           max(coalesce(pl.promotional_price, pl.price)) as preco_maximo,
           count(*)::integer as anuncios_com_preco
    from anuncio_sku x
    join public.listings pl
      on pl.organization_id = p_organization_id
     and pl.ml_account_id = x.ml_account_id
     and pl.item_id = x.item_id
    where pl.status in ('active', 'paused')
      and coalesce(pl.promotional_price, pl.price) is not null
    group by x.sku_id
  ),
  -- A dispersao CHEIA: (maior - menor) / menor x 100, so com dois precos ou
  -- mais. Menor zero da 0, como no diagnostico. O arredondamento e so da
  -- exibicao; o filtro e a ordem comparam o valor cheio (D-630).
  dispersao_sku as (
    select p.sku_id, p.preco_minimo, p.preco_maximo, p.anuncios_com_preco,
           case when p.preco_minimo = 0 then 0::numeric
                else (p.preco_maximo - p.preco_minimo) / p.preco_minimo * 100 end as dispersao_cheia
    from preco_sku p
    where p.anuncios_com_preco >= 2
  ),
  -- O anuncio vinculado por variacao pode ter varios SKUs: a linha leva o
  -- de MAIOR dispersao, e diz qual.
  dispersao_anuncio as (
    select distinct on (x.ml_account_id, x.item_id)
           x.ml_account_id, x.item_id, d.sku_id, d.preco_minimo, d.preco_maximo,
           d.anuncios_com_preco, d.dispersao_cheia
    from anuncio_sku x
    join dispersao_sku d on d.sku_id = x.sku_id
    order by x.ml_account_id, x.item_id, d.dispersao_cheia desc, d.sku_id
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
      vs.orders_observed,
      -- NULA sem snapshot: ausencia de dado nao e zero (D-067).
      fa.full_quantity,
      l.thumbnail_url,
      l.permalink,
      l.in_promotion,
      l.promotional_price,
      l.promotion_checked_at,
      coalesce(l.promotional_price, l.price) as preco_ao_comprador,
      da.preco_minimo,
      da.preco_maximo,
      da.anuncios_com_preco,
      da.dispersao_cheia,
      da.sku_id as dispersao_sku_id,
      qd.estado as estado_da_queda,
      qd.z as z_da_queda,
      qd.calculado_em as calculo_da_queda
    from public.listings l
    join public.ml_accounts a on a.id = l.ml_account_id
    left join public.skus s on s.id = l.sku_id
    left join metricas md on md.ml_account_id = l.ml_account_id and md.mlb_id = l.item_id
    left join visitas  vs on vs.ml_account_id = l.ml_account_id and vs.item_id = l.item_id
    left join vinculos kv on kv.ml_account_id = l.ml_account_id and kv.item_id = l.item_id
    left join full_por_anuncio fa on fa.ml_account_id = l.ml_account_id and fa.item_id = l.item_id
    left join dispersao_anuncio da on da.ml_account_id = l.ml_account_id and da.item_id = l.item_id
    left join public.listing_sales_drop qd
      on qd.ml_account_id = l.ml_account_id
     and qd.item_id = l.item_id
     and qd.periodo_dias = v_queda_dias
    where l.organization_id = p_organization_id
      -- D-631: o anuncio excluido no Mercado Livre sai da tela.
      and l.deleted_at is null
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
      /*
        PROMOCAO (D-419). So o anuncio ATIVO roda campanha, e so ele e lido.
        'without' e "lido, e fora de campanha" -- `in_promotion is false`,
        nunca `is not true`: o NAO LIDO (nulo) nao e oferecido como candidato
        a promocao. Valor fora da lista cai em 'all', como os outros eixos.
      */
      and case p_promo
            when 'with'    then l.status = 'active' and l.in_promotion is true
            when 'without' then l.status = 'active' and l.in_promotion is false
            else true
          end
      /*
        DISPERSAO DE PRECO (C-77, D-625): o SKU desta linha chega ao comprador
        com precos que se afastam MAIS que o teto, pela dispersao cheia e com
        `>` estrito (D-630). Sem dispersao (sem SKU, um preco so) a linha nao e
        divergente. Valor fora da lista cai em 'all', como os outros eixos.
      */
      and case p_preco
            when 'divergente' then da.dispersao_cheia > p_preco_teto
            else true
          end
      -- QUEDA (C-79, D-629): so o estado 'queda' do calculo do dia. O 'sem
      -- historico' nunca entra como queda nem como "sem queda".
      and case p_queda
            when 'queda' then qd.estado = 'queda'
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
         f.in_promotion, f.promotional_price, f.promotion_checked_at,
         count(*) over () as total_count,
         sum(f.gross_revenue) over () as recorte_faturamento,
         sum(f.units_sold) over ()::bigint as recorte_unidades,
         sum(f.visits) over () as recorte_visitas,
         sum(f.orders_observed) over () as recorte_pedidos_observados,
         f.preco_ao_comprador,
         f.preco_minimo,
         f.preco_maximo,
         f.anuncios_com_preco,
         round(f.dispersao_cheia, 1),
         f.dispersao_sku_id,
         f.estado_da_queda,
         round(f.z_da_queda, 2),
         f.calculo_da_queda
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
                              'title_asc', 'title_desc', 'synced_desc', 'synced_asc',
                              'dispersao_desc', 'dispersao_asc')
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
    -- C-77: pela dispersao CHEIA, a mesma do filtro; sem dispersao, no fim.
    case when p_order = 'dispersao_desc'  then f.dispersao_cheia end desc nulls last,
    case when p_order = 'dispersao_asc'   then f.dispersao_cheia end asc  nulls last,
    -- Desempate estavel: sem ele, duas paginas seguidas podem repetir ou
    -- pular um anuncio de mesmo valor.
    f.title asc, f.item_id asc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0);
end;
$$;


create or replace function public.get_listings_dashboard_counts(
  p_organization_id uuid,
  p_ml_account_id uuid default null,
  p_search text default null,
  p_preco_teto numeric default null,
  p_queda_dias integer default null
)
returns table (
  total bigint,
  active bigint,
  paused bigint,
  out_of_stock bigint,
  in_full bigint,
  unlinked bigint,
  -- D-419: so anuncios ATIVOS; os tres somam os ativos.
  in_promotion bigint,
  without_promotion bigint,
  promotion_unknown bigint,
  -- C-77 (D-625): = p_preco 'divergente' com o mesmo teto. NULA sem teto:
  -- sem regua nao ha contagem, e ausencia nao e zero.
  preco_divergente bigint,
  -- C-79 (D-629): = p_queda 'queda' no periodo de p_queda_dias dias. NULA sem
  -- periodo: a faixa nao sabe o periodo da tela sozinha.
  em_queda bigint
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
  -- C-77 (D-625): o conjunto de anuncios de um SKU e o de get_sku_listings
  -- (D-122): listings.sku_id uniao o vinculo ITEM, inclusive o por variacao
  -- (o preco e o do ITEM). So ATIVO ou PAUSADO -- o encerrado fica fora, a
  -- decisao do A2/A3 de 21/10, a mesma do diagnostico do SKU (D-630).
  anuncio_sku as (
    select l.sku_id, l.ml_account_id, l.item_id
    from public.listings l
    where l.organization_id = p_organization_id
      and l.sku_id is not null
    union
    select k.sku_id, k.ml_account_id, k.item_id
    from public.sku_listing_links k
    where k.organization_id = p_organization_id
      and k.ref_kind = 'ITEM'
      and k.item_id is not null
  ),
  -- O preco que chega ao comprador: o promocional, senao o cadastrado
  -- (D-389), o mesmo `precoEfetivo` do diagnostico do SKU.
  preco_sku as (
    select x.sku_id,
           min(coalesce(pl.promotional_price, pl.price)) as preco_minimo,
           max(coalesce(pl.promotional_price, pl.price)) as preco_maximo,
           count(*)::integer as anuncios_com_preco
    from anuncio_sku x
    join public.listings pl
      on pl.organization_id = p_organization_id
     and pl.ml_account_id = x.ml_account_id
     and pl.item_id = x.item_id
    where pl.status in ('active', 'paused')
      and coalesce(pl.promotional_price, pl.price) is not null
    group by x.sku_id
  ),
  -- A dispersao CHEIA: (maior - menor) / menor x 100, so com dois precos ou
  -- mais. Menor zero da 0, como no diagnostico. O arredondamento e so da
  -- exibicao; o filtro e a ordem comparam o valor cheio (D-630).
  dispersao_sku as (
    select p.sku_id, p.preco_minimo, p.preco_maximo, p.anuncios_com_preco,
           case when p.preco_minimo = 0 then 0::numeric
                else (p.preco_maximo - p.preco_minimo) / p.preco_minimo * 100 end as dispersao_cheia
    from preco_sku p
    where p.anuncios_com_preco >= 2
  ),
  -- O anuncio vinculado por variacao pode ter varios SKUs: a linha leva o
  -- de MAIOR dispersao, e diz qual.
  dispersao_anuncio as (
    select distinct on (x.ml_account_id, x.item_id)
           x.ml_account_id, x.item_id, d.sku_id, d.preco_minimo, d.preco_maximo,
           d.anuncios_com_preco, d.dispersao_cheia
    from anuncio_sku x
    join dispersao_sku d on d.sku_id = x.sku_id
    order by x.ml_account_id, x.item_id, d.dispersao_cheia desc, d.sku_id
  ),
  escopo as (
    -- O ESCOPO da faixa e conta + busca, sem filtro de estado: cada celula E
    -- um filtro de estado (mesmo raciocinio da tela desde D-242).
    select l.status, l.available_quantity, l.sku_id, kv.item_id as vinculo_por_variacao,
           fa.full_quantity, l.in_promotion as em_promocao, da.dispersao_cheia,
           qd.estado as estado_da_queda
    from public.listings l
    join public.ml_accounts a on a.id = l.ml_account_id
    left join public.skus s on s.id = l.sku_id
    left join vinculos kv on kv.ml_account_id = l.ml_account_id and kv.item_id = l.item_id
    left join full_por_anuncio fa on fa.ml_account_id = l.ml_account_id and fa.item_id = l.item_id
    left join dispersao_anuncio da on da.ml_account_id = l.ml_account_id and da.item_id = l.item_id
    left join public.listing_sales_drop qd
      on qd.ml_account_id = l.ml_account_id
     and qd.item_id = l.item_id
     and qd.periodo_dias = p_queda_dias
    where l.organization_id = p_organization_id
      -- D-631: o anuncio excluido no Mercado Livre sai da tela.
      and l.deleted_at is null
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
    count(*) filter (where e.sku_id is null and e.vinculo_por_variacao is null),
    -- = p_promo 'with' / 'without'; o resto dos ativos e o NAO LIDO.
    count(*) filter (where e.status = 'active' and e.em_promocao is true),
    count(*) filter (where e.status = 'active' and e.em_promocao is false),
    count(*) filter (where e.status = 'active' and e.em_promocao is null),
    -- = p_preco 'divergente' com o mesmo teto.
    case when p_preco_teto is null then null
         else count(*) filter (where e.dispersao_cheia > p_preco_teto) end,
    -- = p_queda 'queda' no mesmo periodo.
    case when p_queda_dias is null then null
         else count(*) filter (where e.estado_da_queda = 'queda') end
  from escopo e;
end;
$$;


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
  -- D-631: o anuncio excluido no Mercado Livre sai do SKU; o par sem linha de
  -- anuncio (o vinculo que so existe no cache) continua.
  where l.deleted_at is null
  order by a.label nulls last, l.title nulls last, p.item_id
$$;


create or replace function public.get_listings_link_overview(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  -- 'all' | 'linked' | 'unlinked' -- o MESMO vocabulario de
  -- get_listings_dashboard, para a traducao da web continuar num lugar so
  -- (`toRpcArgs`, lib/link-integrity-filters.ts).
  p_link_state text default 'all',
  -- 'all' | 'with' | 'without' -- houve venda na janela (D-259).
  p_sold text default 'all',
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $fn$
declare
  v_resultado jsonb;
begin
  with metricas as (
    -- Venda na janela, por anuncio. Ausencia de metrica E ausencia de venda
    -- (diferente do Full, onde ausencia de snapshot nao e estoque zero, D-067).
    select m.ml_account_id,
           m.mlb_id,
           sum(m.units_sold)::bigint as units_sold,
           sum(m.gross_revenue)      as gross_revenue
    from public.daily_listing_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date between p_date_from and p_date_to
    group by m.ml_account_id, m.mlb_id
  ),
  vinculos as (
    -- Vinculo POR VARIACAO: o anuncio tem link mas `listings.sku_id` e nulo.
    -- D-122 mediu que tratar nulo como "sem vinculo" DOBRARIA o numero.
    select distinct k.ml_account_id, k.item_id
    from public.sku_listing_links k
    where k.organization_id = p_organization_id
  ),
  full_ultimo as (
    -- A definicao canonica de Full (D-173/D-204): o ultimo snapshot por
    -- (conta, inventory_id), so dos ultimos 3 dias.
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
  candidatos as (
    select c.ml_account_id, count(*) as abertos
    from public.link_candidates c
    where c.organization_id = p_organization_id
      and c.status = 'OPEN'
    group by c.ml_account_id
  ),
  base as (
    -- TODOS os anuncios da organizacao, sem o recorte de conta nem a busca: e
    -- desta CTE que sai a comparacao entre contas, que ignora o filtro de
    -- conta de proposito -- comparar e o servico dela (D-128).
    select l.id                 as listing_id,
           l.item_id,
           l.title,
           l.price,
           l.ml_account_id,
           a.label              as account_label,
           a.slug               as account_slug,
           l.sku_id,
           s.sku,
           case when l.sku_id is not null   then 'linked'
                when kv.item_id is not null then 'linked_variation'
                else 'unlinked' end as link_state,
           coalesce(md.units_sold, 0)::bigint as units_sold,
           coalesce(md.gross_revenue, 0)      as gross_revenue,
           -- NULA sem snapshot: ausencia de dado nao e zero (D-067).
           fa.full_quantity
    from public.listings l
    join public.ml_accounts a on a.id = l.ml_account_id
    left join public.skus s on s.id = l.sku_id
    left join metricas md on md.ml_account_id = l.ml_account_id and md.mlb_id = l.item_id
    left join vinculos kv on kv.ml_account_id = l.ml_account_id and kv.item_id = l.item_id
    left join full_por_anuncio fa on fa.ml_account_id = l.ml_account_id and fa.item_id = l.item_id
    where l.organization_id = p_organization_id
      -- D-631: o anuncio excluido no Mercado Livre sai da tela.
      and l.deleted_at is null
  ),
  por_conta as (
    /*
      Sai de `ml_accounts`, nao de `base`: agrupar os anuncios faria a conta
      recem-conectada, ainda sem anuncio sincronizado, DESAPARECER da
      comparacao — e "nao aparece" se le como "nao existe", quando o certo e
      "ainda nao tem anuncio". Ela entra com zeros e percentual NULO.
    */
    select a.id                                                     as ml_account_id,
           a.label                                                  as account_label,
           a.slug                                                   as account_slug,
           count(b.listing_id)                                      as listings_total,
           count(*) filter (where b.link_state <> 'unlinked')       as com_vinculo,
           count(*) filter (where b.link_state = 'unlinked')        as sem_vinculo,
           -- Sem anuncio nenhum NAO ha percentual: "0%" afirmaria que nenhum
           -- esta vinculado. Nulo aqui quer dizer "nao se aplica" (D-254).
           round(100.0 * count(*) filter (where b.link_state <> 'unlinked')
                 / nullif(count(b.listing_id), 0), 1)                as pct_vinculado,
           count(*) filter (where b.link_state = 'unlinked' and b.units_sold > 0) as vendidos_sem_vinculo,
           coalesce(sum(b.gross_revenue) filter (where b.link_state = 'unlinked'), 0) as receita_sem_vinculo,
           coalesce((select k.abertos from candidatos k where k.ml_account_id = a.id), 0) as candidatos_abertos
    from public.ml_accounts a
    left join base b on b.ml_account_id = a.id
    where a.organization_id = p_organization_id
    group by a.id, a.label, a.slug
  ),
  recorte as (
    -- A JANELA declarada da tela: conta escolhida e busca. As contagens dos
    -- cartoes saem DAQUI, para que clicar num cartao mostre as linhas que ele
    -- promete (D-242) -- inclusive com a busca ativa.
    select * from base b
    where (p_ml_account_id is null or b.ml_account_id = p_ml_account_id)
      and (p_search is null
           or b.item_id ilike '%' || p_search || '%'
           or b.title   ilike '%' || p_search || '%'
           or b.sku     ilike '%' || p_search || '%')
  ),
  contagens as (
    select count(*)                                                  as todos,
           count(*) filter (where r.link_state <> 'unlinked')         as vinculados,
           count(*) filter (where r.link_state = 'linked_variation')  as por_variacao,
           count(*) filter (where r.link_state = 'unlinked')          as sem_vinculo,
           count(*) filter (where r.link_state = 'unlinked' and r.units_sold > 0) as vendidos_sem_vinculo,
           count(*) filter (where r.link_state = 'unlinked' and r.units_sold = 0) as parados_sem_vinculo,
           -- Zero legitimo: sem anuncio sem vinculo NAO ha receita em risco.
           coalesce(sum(r.gross_revenue) filter (where r.link_state = 'unlinked'), 0) as receita_sem_vinculo,
           coalesce(sum(r.units_sold)    filter (where r.link_state = 'unlinked'), 0) as unidades_sem_vinculo,
           -- A fila do ERP nao tem titulo nem MLB para a busca casar, entao ela
           -- segue a conta escolhida e IGNORA `p_search` -- e o cartao dela diz
           -- isso na tela quando ha busca ativa.
           (select coalesce(sum(k.abertos), 0)
            from candidatos k
            where p_ml_account_id is null or k.ml_account_id = p_ml_account_id) as candidatos_abertos
    from recorte r
  ),
  filtrado as (
    select * from recorte r
    where case p_link_state
            when 'linked'   then r.link_state <> 'unlinked'
            when 'unlinked' then r.link_state = 'unlinked'
            else true
          end
      and case p_sold
            when 'with'    then r.units_sold > 0
            when 'without' then r.units_sold = 0
            else true
          end
  ),
  pagina as (
    -- Pela receita da janela: o anuncio sem vinculo que mais fatura e o que
    -- mais custa caro deixar sem vinculo, e aparece primeiro.
    select f.*, count(*) over () as total_count
    from filtrado f
    order by f.gross_revenue desc, f.title asc, f.item_id asc
    limit greatest(p_limit, 0)
    offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'total',     coalesce((select max(p.total_count) from pagina p), 0),
    'contagens', (select to_jsonb(c) from contagens c),
    'por_conta', coalesce((select jsonb_agg(to_jsonb(q) order by q.account_label) from por_conta q), '[]'::jsonb),
    'linhas',    coalesce((select jsonb_agg(to_jsonb(p) - 'total_count'
                                            order by p.gross_revenue desc, p.title asc, p.item_id asc)
                           from pagina p), '[]'::jsonb)
  )
  into v_resultado;

  return v_resultado;
end;
$fn$;

