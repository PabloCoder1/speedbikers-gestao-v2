-- ============================================================
-- D-629 -- C-79: a queda nas vendas por anuncio na lista de /anuncios.
--
-- Pedido do dono via A3 (21/10): o atalho "Queda nas vendas" sobre o
-- catalogo inteiro, com a contagem. A regua fechada com o A2/A3 e a da venda
-- anomala (D-064), em janelas: as unidades do periodo contra as 8 janelas
-- anteriores de mesmo tamanho, z <= -2, 4 amostras ou mais, media > 0,
-- desvio > 0, so dias fechados, e "sem historico" quando nao ha regua.
--
-- A base le a maior parte de daily_listing_metrics (medido em producao: ~0,9 s
-- com cache frio so a primeira venda), entao o calculo e pre-feito uma vez
-- por dia pelo worker, para os cinco periodos da tela, em
-- `listing_sales_drop`; a lista, a faixa e o CSV leem por juncao. O corpo da
-- lista e o de 20261021140000 (D-625); drop + create porque muda a assinatura.
-- ============================================================

-- ------------------------------------------------------------
-- 1. O resultado, uma linha por (conta, anuncio, periodo da tela).
-- ------------------------------------------------------------
create table public.listing_sales_drop (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ml_account_id uuid not null references public.ml_accounts(id) on delete cascade,
  item_id text not null check (item_id ~ '^MLB[0-9]+$'),
  -- Os periodos da /anuncios (PERIOD_PRESETS da tela).
  periodo_dias integer not null check (periodo_dias in (7, 15, 30, 60, 90)),
  -- O periodo termina ONTEM: so dias fechados de Sao Paulo.
  periodo_de date not null,
  periodo_ate date not null,
  unidades_periodo bigint not null check (unidades_periodo >= 0),
  -- As janelas anteriores de mesmo tamanho que contam (o anuncio ja existia).
  amostras integer not null check (amostras between 0 and 8),
  media_anterior numeric,
  desvio numeric,
  -- NULO sem regua: menos de 4 amostras, media zero ou desvio zero.
  z numeric,
  estado text not null check (estado in ('queda', 'normal', 'sem_historico')),
  calculado_em timestamptz not null,
  primary key (ml_account_id, item_id, periodo_dias),
  check ((estado = 'sem_historico') = (z is null))
);

create index listing_sales_drop_org_periodo_idx on public.listing_sales_drop (organization_id, periodo_dias);

comment on table public.listing_sales_drop is
  'A queda nas vendas por anuncio (D-629, C-79): as unidades do periodo (dias fechados ate ontem) contra as 8 janelas anteriores de mesmo tamanho, z <= -2 com 4 amostras ou mais, media > 0 e desvio > 0 (os limiares da venda anomala, D-064). Recalculada uma vez por dia pelo worker; a tela le por juncao.';

alter table public.listing_sales_drop enable row level security;

create policy listing_sales_drop_select_own_account
  on public.listing_sales_drop for select to authenticated
  -- A forma por CONJUNTO (D-181), nunca a escalar por linha.
  using (ml_account_id in (select private.accessible_accounts()));

grant select on public.listing_sales_drop to authenticated;
grant select, insert, update, delete on public.listing_sales_drop to service_role;
revoke all on public.listing_sales_drop from anon;

-- ------------------------------------------------------------
-- 2. O calculo, por organizacao, de uma vez: os cinco periodos.
-- ------------------------------------------------------------
create or replace function public.recalcular_queda_anuncios(
  p_organization_id uuid,
  p_hoje date default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
-- Plano com os valores (D-305): com o fim da janela conhecido, a leitura da
-- metrica e em sequencia; o plano generico iria pelo indice.
set plan_cache_mode = 'force_custom_plan'
-- Medido em producao (21/10): com o padrao, a agregacao das janelas
-- transbordava para o disco.
set work_mem = '64MB'
as $$
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
$$;

comment on function public.recalcular_queda_anuncios(uuid, date) is
  'Recalcula listing_sales_drop da organizacao (D-629, C-79): os cinco periodos da /anuncios, terminando ontem, contra as 8 janelas anteriores de mesmo tamanho desde a primeira venda do anuncio; z <= -2 com 4 amostras ou mais, media > 0 e desvio > 0 (stddev_samp, como D-064). Apaga e regrava a organizacao numa transacao. So o worker chama (service_role).';

revoke all on function public.recalcular_queda_anuncios(uuid, date) from public, anon, authenticated;
grant execute on function public.recalcular_queda_anuncios(uuid, date) to service_role;

-- ------------------------------------------------------------
-- 3. A lista e a faixa leem a queda.
-- ------------------------------------------------------------
drop function if exists public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text, text, text, text, numeric);

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


comment on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text, text, text, text, numeric, text) is
  'Dashboard de /anuncios (D-138), com Full por anuncio (D-243), venda na janela (D-259), ordem escolhida (p_order, lista fechada, padrao revenue_desc), foto/link do ML e promocao (p_promo, D-419: so ativos; ''without'' e lido e fora de campanha, nunca o nao lido). p_link_state NAO e sku_id is null: anuncios tem vinculo POR VARIACAO (D-122). As celulas da faixa saem de get_listings_dashboard_counts, com o predicado copiado deste e preso por teste de integracao. C-77 (D-625): a dispersao de preco do SKU (preco efetivo, entre os anuncios ativos e pausados do conjunto de get_sku_listings), p_preco ''divergente'' com p_preco_teto (a dispersao cheia, > estrito) e a ordem dispersao_desc/asc. C-79 (D-629): a queda nas vendas (listing_sales_drop, pelo numero de dias do periodo quando ele termina hoje) e p_queda ''queda''. plpgsql + force_custom_plan desde D-305. security invoker.';

revoke all on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text, text, text, text, numeric, text) from public, anon;
grant execute on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text, text, text, text, numeric, text) to authenticated, service_role;

drop function if exists public.get_listings_dashboard_counts(uuid, uuid, text, numeric);

create function public.get_listings_dashboard_counts(
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


comment on function public.get_listings_dashboard_counts(uuid, uuid, text, numeric, integer) is
  'As celulas da faixa de /anuncios (total, ativos, pausados, sem estoque, no Full, sem vinculo) e as tres de promocao dos ativos (em promocao, sem promocao, nao lido -- D-419) numa passada, sem os CTEs de venda e visitas. C-77 (D-625): preco_divergente com p_preco_teto, NULA sem teto. C-79 (D-629): em_queda com p_queda_dias, NULA sem periodo. Cada predicado e copia do de get_listings_dashboard; o teste de integracao compara as duas. security invoker.';

revoke all on function public.get_listings_dashboard_counts(uuid, uuid, text, numeric, integer) from public, anon;
grant execute on function public.get_listings_dashboard_counts(uuid, uuid, text, numeric, integer) to authenticated, service_role;
