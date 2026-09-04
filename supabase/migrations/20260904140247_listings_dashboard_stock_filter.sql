-- ============================================================
-- `/anuncios` ganha o recorte por ESTOQUE DO ANUNCIO (D-242).
--
-- O frame `Listings` do Figma pede duas coisas que a RPC nao sabia responder:
-- a celula de resumo "Sem estoque" e o botao "Com estoque" da barra da tabela.
-- As duas sao o mesmo predicado, `available_quantity = 0` / `> 0`, sobre uma
-- coluna que ja existe e e NOT NULL — a particao entre as duas e completa, sem
-- terceira classe silenciosa.
--
-- **Por que no Postgres e nao na tela.** A contagem de "sem estoque" precisa
-- valer sobre o CONJUNTO INTEIRO, nao sobre a pagina de 50 que a tela le. Fazer
-- a conta no navegador contaria a janela e chamaria o resultado de total — a
-- classe de defeito que D-138 corrigiu nesta mesma tela (mostrava 1.000 de
-- 5.085 em silencio). E, feito aqui, o numero da celula e o `total_count` do
-- MESMO predicado que o link do "ver lista" aplica: contagem e lista nao podem
-- divergir porque sao a mesma consulta.
--
-- O filtro entra no `where` de `base`, junto de conta/estado/busca: e coluna
-- propria de `listings`, entao poda antes dos joins de metrica e visita em vez
-- de depois.
--
-- `p_stock` aceita 'all' | 'out' | 'in'; qualquer outro valor cai em 'all', que
-- e o comportamento de quem nao passa o argumento. Nao ha `else false`: um
-- valor desconhecido devolvendo zero linhas seria indistinguivel de um filtro
-- legitimo sem resultado — mesmo motivo pelo qual `resolveStatusFilter` na tela
-- trabalha com lista fechada.
--
-- DROP + CREATE porque a lista de argumentos muda (42P13), mesmo caminho das
-- duas migrations anteriores desta funcao.
-- ============================================================

drop function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer);

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
  -- 'all' | 'out' | 'in' — estoque DO ANUNCIO no Mercado Livre, que nao e o
  -- saldo do ERP nem o do Full. Sao graos diferentes e nao se somam.
  --
  -- ULTIMO de proposito, depois de `p_offset`: a suite de integracao chama
  -- esta funcao POSICIONALMENTE, e um argumento novo no meio da lista quebra
  -- todo chamador SQL que ja existia. No fim, quem nao passa continua igual.
  p_stock text default 'all'
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
    -- Conjunto, nao subconsulta correlacionada: ver a nota de EXPLAIN da
    -- migration anterior.
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
      and case p_stock
            when 'out' then l.available_quantity = 0
            when 'in'  then l.available_quantity > 0
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
         -- Contagem do conjunto FILTRADO, antes do limite.
         count(*) over () as total_count
  from filtrado f
  -- Ordenacao deterministica e COMPLETA.
  order by f.gross_revenue desc, f.title asc, f.item_id asc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0)
$$;

comment on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text) is
  'Dashboard de anuncios (D-138/D-170/D-242): pivo, filtros, ordenacao e CONTAGEM no Postgres, janela declarada na tela. `p_stock` recorta pelo estoque DO ANUNCIO no Mercado Livre (available_quantity), que nao e o saldo do ERP nem o do Full — graos diferentes. A tela usa o `total_count` desta mesma funcao nas celulas de resumo, entao contagem e lista nao divergem.';

-- Os grants do DROP + CREATE, os dois lados. O Postgres da EXECUTE a PUBLIC em
-- toda funcao nova, entao sem o REVOKE o `anon` alcancaria esta RPC — foi o
-- guard de D-182 na suite de integracao que pegou exatamente isso na primeira
-- versao desta migration. E o DROP leva os grants antigos junto: perder
-- `service_role` em silencio tiraria a funcao do alcance do worker.
revoke all on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text) from public, anon;
grant execute on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text) to authenticated, service_role;
