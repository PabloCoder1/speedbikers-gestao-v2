-- ============================================================
-- A conversao de /anuncios entra na definicao canonica (D-170).
--
-- Esta era a TERCEIRA implementacao da mesma metrica no repositorio, e a
-- unica que a tela realmente usava: `get_listing_traffic` (percentual, sem
-- consumidor de tela), `get_listing_dashboard_summary` (fracao, D-168) e
-- esta. As duas primeiras foram alinhadas na migration anterior; sem esta,
-- o catalogo descreveria uma metrica que a tela principal nao segue.
--
-- Mesmas duas correcoes: FRACAO (a tela formata com `formatPercent`, que
-- recebe fracao) e numerador restrito aos DIAS COM VISITA OBSERVADA.
-- `days_observed` sai junto para a tela declarar sobre quantos dias a razao
-- foi calculada.
--
-- MEDIDO COM EXPLAIN (ANALYZE, BUFFERS) ANTES DO MERGE, e a primeira
-- formulacao foi REPROVADA: juntar `daily_listing_metrics` linha a linha
-- contra as 14.984 visitas produziu Nested Loop com Memoize — 14.984 index
-- lookups, **50.949 buffers, 130 ms**. Agregar as metricas POR DIA antes
-- (`metricas_dia`) troca isso por um hash join entre dois conjuntos ja
-- reduzidos: **4.149 buffers, 59,8 ms** — mais rapido que a versao ANTIGA
-- da funcao, que media 578 ms sem sequer fazer esta conta.
--
-- `metricas` passa a derivar de `metricas_dia` em vez de varrer
-- `daily_listing_metrics` de novo: uma leitura da tabela, nao duas.
--
-- DROP + CREATE porque a lista de OUT parameters mudou (42P13), o mesmo
-- caminho da migration anterior.
--
-- Conferido no Dev depois de aplicar, sobre os 5.085 anuncios reais:
-- 0 conversoes acima de 100% (eram 93), 0 taxas sem denominador, maior
-- valor exatamente 1,0000, ate 11 dias observados na janela de agosto.
-- ============================================================

drop function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer);

create function public.get_listings_dashboard(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_status text default null,
  -- 'all' | 'linked' | 'unlinked'. NÃO é `sku_id is null`: D-122 mediu que
  -- 1.013 dos 1.917 anúncios com `sku_id` nulo têm vínculo POR VARIAÇÃO.
  p_link_state text default 'all',
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  listing_id uuid, item_id text, title text, status text, price numeric,
  available_quantity integer, synced_at timestamptz, ml_account_id uuid,
  account_label text, sku_id uuid, sku text, link_state text,
  units_sold bigint, gross_revenue numeric, visits numeric,
  days_observed integer, conversion_rate numeric, total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with metricas_dia as (
    -- Grao (conta, anuncio, DIA): serve tanto ao total da janela quanto ao
    -- recorte dos dias observados, sem ler a tabela duas vezes.
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
           -- Pedidos SO dos dias em que houve visita observada.
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
    -- Conjunto, não subconsulta correlacionada: ver a nota de EXPLAIN acima.
    select distinct k.ml_account_id, k.item_id
    from public.sku_listing_links k
    where k.organization_id = p_organization_id
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
      -- NULA sem visita, nunca zero: sem denominador nao existe taxa. Medido
      -- em D-123: 1.060 anuncios vendem sem visita registrada, porque a
      -- varredura ainda nao alcanca itens com variacao. Zero ali afirmaria
      -- "ninguem converteu".
      round(vs.orders_observed::numeric / nullif(vs.visits, 0), 4) as conversion_rate
    from public.listings l
    join public.ml_accounts a on a.id = l.ml_account_id
    left join public.skus s on s.id = l.sku_id
    left join metricas md on md.ml_account_id = l.ml_account_id and md.mlb_id = l.item_id
    left join visitas  vs on vs.ml_account_id = l.ml_account_id and vs.item_id = l.item_id
    left join vinculos kv on kv.ml_account_id = l.ml_account_id and kv.item_id = l.item_id
    where l.organization_id = p_organization_id
      and (p_ml_account_id is null or l.ml_account_id = p_ml_account_id)
      and (p_status is null or l.status = p_status)
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
         -- Contagem do conjunto FILTRADO, antes do limite.
         count(*) over () as total_count
  from filtrado f
  -- Ordenação determinística e COMPLETA.
  order by f.gross_revenue desc, f.title asc, f.item_id asc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0)
$$;

comment on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer) is
  'Dashboard de anuncios: catalogo real (D-121) com venda, visitas e conversao ja juntadas em SQL, filtros e janela. conversion_rate segue a definicao canonica taxa_conversao (D-170): FRACAO, numerador restrito aos dias com visita observada, days_observed ao lado. Devolve total_count do conjunto filtrado para a tela nunca afirmar que mostrou tudo.';

revoke all on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer) from public, anon;
grant execute on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer) to authenticated, service_role;
