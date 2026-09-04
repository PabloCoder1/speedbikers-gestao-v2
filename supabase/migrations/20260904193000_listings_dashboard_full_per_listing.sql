-- ============================================================
-- Full POR ANUNCIO em `/anuncios` (D-243) — a correcao de um desvio errado.
--
-- D-242 registrou que a celula "No Full" e a coluna "Full" do frame `Listings`
-- ficavam de fora porque "Full e fato de SKU; `listings` nao tem coluna de
-- logistica". A auditoria de fidelidade conferiu o schema e o motivo nao
-- bate: `fulfillment_stock_snapshots` carrega `item_id` (o MLB) e
-- `variation_id` — o snapshot de Full e capturado POR ANUNCIO, e e assim que
-- `get_sku_dashboard` ja o le (`distinct on (ml_account_id, item_id,
-- variation_id) ... order by captured_at desc`). O grao existe; faltava
-- olhar.
--
-- Entao a RPC passa a devolver `full_quantity`: a soma, por anuncio, do ULTIMO
-- snapshot de cada bucket (`inventory_id`) dos ultimos 3 dias — a definicao
-- canonica de D-173/D-204. NULA quando nao ha snapshot recente para o anuncio —
-- ausencia de snapshot nao e saldo zero (D-067), e a tela mostra "—". E ganha
-- `p_full` ('all' | 'with' | 'without') para a celula "No Full" e o recorte
-- da lista sairem do MESMO predicado, como `p_stock` em D-242:
--   with    = full_quantity > 0
--   without = full_quantity e nulo OU zero  (o anuncio nao esta no Full hoje;
--             "nunca teve snapshot" e "teve e zerou" cabem os dois aqui, e a
--             coluna distingue um do outro)
--
-- O ultimo snapshot e escolhido ANTES de agregar por anuncio, num CTE proprio
-- (`full_ultimo`), porque `distinct on` e `sum` no mesmo nivel somariam todos
-- os snapshots historicos. Poda por organizacao, como os outros CTEs.
-- "Sem snapshot nos ultimos 3 dias" e "nunca teve" caem os dois em NULL: a
-- varredura roda duas vezes por dia, entao 3 dias sem captura e ausencia de
-- dado, nao saldo.
--
-- DROP + CREATE porque a lista de argumentos e a de retorno mudam (42P13).
-- Os grants sao recriados com os dois papeis de antes.
-- ============================================================

drop function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text);

create function public.get_listings_dashboard(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_status text default null,
  -- 'all' | 'linked' | 'unlinked'. NAO e `sku_id is null`: D-122 mediu que
  -- 1.013 dos 1.917 anuncios com `sku_id` nulo tem vinculo POR VARIACAO.
  p_link_state text default 'all',
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  -- Os filtros novos entram DEPOIS de limit/offset, de proposito: a suite de
  -- integracao chama esta funcao por posicao, e inserir um argumento no meio
  -- deslocaria os dela (licao de D12).
  -- 'all' | 'out' | 'in' — estoque DO ANUNCIO no Mercado Livre (D-242).
  p_stock text default 'all',
  -- 'all' | 'with' | 'without' — Full DO ANUNCIO, pelo ultimo snapshot (D-243).
  p_full text default 'all'
)
returns table (
  listing_id uuid, item_id text, title text, status text, price numeric,
  available_quantity integer, synced_at timestamptz, ml_account_id uuid,
  account_label text, sku_id uuid, sku text, link_state text,
  units_sold bigint, gross_revenue numeric, visits numeric,
  days_observed integer, conversion_rate numeric,
  full_quantity numeric,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
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
    -- — o bucket que o Mercado Livre reparte —, e so dos ultimos 3 dias. O guard
    -- de D-204 recusa qualquer funcao que leia esta tabela com outro grao: a
    -- primeira versao desta migration usava (item_id, variation_id) sem janela e
    -- foi barrada por ele antes de chegar ao CI.
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
      fa.full_quantity
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
      and (p_search is null
           or l.item_id ilike '%' || p_search || '%'
           or l.title   ilike '%' || p_search || '%'
           or s.sku     ilike '%' || p_search || '%')
  ),
  filtrado as (
    select * from base
    where case p_link_state
            when 'linked'   then link_state in ('linked', 'linked_variation')
            when 'unlinked' then link_state = 'unlinked'
            else true
          end
  )
  select f.listing_id, f.item_id, f.title, f.status, f.price, f.available_quantity,
         f.synced_at, f.ml_account_id, f.account_label, f.sku_id, f.sku, f.link_state,
         f.units_sold, f.gross_revenue, f.visits, f.days_observed, f.conversion_rate,
         f.full_quantity,
         count(*) over () as total_count
  from filtrado f
  order by f.gross_revenue desc, f.title asc, f.item_id asc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0)
$$;

comment on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text) is
  'Dashboard de anuncios (D-138/D-170/D-242/D-243): pivo, filtros, ordenacao e CONTAGEM no Postgres, janela declarada na tela. `p_stock` recorta pelo estoque DO ANUNCIO (available_quantity); `p_full` pelo Full DO ANUNCIO, soma do ultimo snapshot por inventory_id dos ultimos 3 dias (definicao canonica D-173/D-204) — NULO sem snapshot recente. A tela usa o total_count desta mesma funcao nas celulas de resumo, entao contagem e lista nao divergem.';

-- O Postgres da EXECUTE a PUBLIC em toda funcao nova (D-182/D-242): revogar
-- ANTES do grant, senao `anon` alcanca a RPC.
revoke execute on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text) from public, anon;
grant execute on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text) to authenticated, service_role;
