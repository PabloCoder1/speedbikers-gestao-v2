-- `/anuncios` mostrava 1.000 de 5.085 anúncios, em silêncio (D-138).
--
-- SEXTA ocorrência da classe de D-131 e a primeira encontrada depois dela: a
-- página lia `from("listings").select(...).order("title")` sem `.range()`,
-- contra 5.085 linhas e o teto `max_rows = 1000` de `supabase/config.toml`.
-- O PostgREST corta a resposta e devolve `error` NULO — nada quebra, a tela
-- some com 80% do catálogo e ainda ordena por título, então o que sobrevive é
-- "os 1.000 primeiros no alfabeto", que não é um critério de nada.
--
-- O defeito nasceu com D-121: enquanto `listings` era enumerada por
-- `sku_listing_links` a tabela cabia no teto; ao passar a conter o catálogo
-- REAL do vendedor ela cresceu para 5.085 e a leitura sem paginação virou
-- truncamento. D-131 corrigiu cinco pontos no mesmo dia e não alcançou este.
--
-- A correção segue o precedente que D-131 estabeleceu para `/estoque`, e NÃO
-- o `readAllPages` do worker: numa tela, trazer 5.085 linhas para o navegador
-- para mostrar 50 é desperdício: o pivô, os filtros, a ordenação e a CONTAGEM
-- passam para o Postgres, e a página lê uma janela declarada.
--
-- `total_count` é o ponto inteiro desta função. Sem ele a tela não tem como
-- distinguir "estes são todos os anúncios" de "estes são os primeiros N" — que
-- é exatamente a ambiguidade que deixou o truncamento invisível por um dia
-- inteiro de operação.
--
-- MEDIDO COM `EXPLAIN (ANALYZE, BUFFERS)` ANTES DO MERGE (docs/ARCHITECTURE.md
-- §21), e a primeira versão desta função foi REPROVADA por ele:
--
--   * duas varreduras de `daily_listing_metrics` (uma para venda, outra para
--     pedidos) com o mesmo `group by` e a mesma janela — unificadas numa CTE
--     `metricas` só;
--   * e o defeito caro: `exists (select 1 from sku_listing_links ...)`
--     CORRELACIONADO. Fora da função ele engana, porque só roda para as linhas
--     que sobrevivem ao `limit`; aqui o filtro `p_link_state` obriga a avaliá-lo
--     para TODAS as 5.085 linhas, cada uma varrendo as 20.650 de
--     `sku_listing_links`. Trocado por um `left join` contra `vinculos`
--     (distinct, uma passada). **1.123 ms -> 137 ms**, no filtro mais pesado
--     (`unlinked`, que é justamente o que força a avaliação).
--
-- Nenhum índice novo: o plano final usa `daily_listing_metrics_account_date_idx`
-- e resolve o resto em hash join sobre tabelas pequenas. `docs/DATABASE.md` §6
-- exige EXPLAIN antes de criar índice, e ele não pediu nenhum.
--
-- Contagens conferidas contra D-122, que é quem estabeleceu a semântica:
-- 5.085 no total, 4.181 vinculados (3.168 diretos + 1.013 por variação) e
-- **904 sem vínculo** (654 ativos) — os mesmos números.
--
-- `security invoker`: a RLS de `listings`/`sku_listing_links`/
-- `daily_listing_metrics` decide o escopo por chamador, mesmo padrão de
-- `get_listing_sales`, `get_unlinked_listings` e `get_stock_coverage`.

create function public.get_listings_dashboard(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_status text default null,
  -- 'all' | 'linked' | 'unlinked'. NÃO é `sku_id is null`: D-122 mediu que
  -- 1.013 dos 1.917 anúncios com `sku_id` nulo têm vínculo POR VARIAÇÃO. Sem
  -- vínculo nenhum são 904. Tratar nulo como "sem vínculo" reintroduziria o
  -- erro que D-122 corrigiu, e a fila de trabalho ficaria com o dobro do
  -- tamanho real.
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
  conversion_rate numeric, total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with metricas as (
    -- UMA varredura para venda E pedidos: mesmo grão, mesma janela. A primeira
    -- versão fazia duas. Sem filtro de `variation_id` (D-123).
    select m.ml_account_id, m.mlb_id,
           sum(m.units_sold)::bigint as units_sold,
           sum(m.gross_revenue)      as gross_revenue,
           sum(m.orders_count)       as orders_count
    from public.daily_listing_metrics m
    where m.organization_id = p_organization_id
      and m.metric_date between p_date_from and p_date_to
    group by m.ml_account_id, m.mlb_id
  ),
  visitas as (
    select v.ml_account_id, v.item_id, sum(v.visits) as visits
    from public.daily_listing_visits v
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
      -- `conversion_rate` NULA quando não há visita, nunca zero: sem
      -- denominador não existe taxa. Medido em D-123: 1.060 anúncios vendem
      -- sem visita registrada, porque a varredura de visitas ainda não
      -- alcança itens com variação. Zero ali afirmaria "ninguém converteu".
      case when coalesce(vs.visits, 0) = 0 then null
           else round(coalesce(md.orders_count, 0)::numeric / vs.visits * 100, 2)
      end as conversion_rate
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
            -- 'linked' inclui o vínculo por variação DE PROPÓSITO: para quem
            -- pergunta "o que ainda falta vincular?", um anúncio ligado por
            -- variação já está resolvido. A coluna `link_state` continua
            -- distinguindo os dois na tela.
            when 'linked'   then link_state in ('linked', 'linked_variation')
            when 'unlinked' then link_state = 'unlinked'
            else true
          end
  )
  select f.listing_id, f.item_id, f.title, f.status, f.price, f.available_quantity,
         f.synced_at, f.ml_account_id, f.account_label, f.sku_id, f.sku, f.link_state,
         f.units_sold, f.gross_revenue, f.visits, f.conversion_rate,
         -- Contagem do conjunto FILTRADO, antes do limite. É o que permite à
         -- tela dizer "50 de 904" em vez de deixar o usuário achar que viu tudo.
         count(*) over () as total_count
  from filtrado f
  -- Ordenação determinística e COMPLETA: `item_id` é único por conta, então o
  -- terceiro critério elimina empate residual. Sem isso, duas páginas
  -- consecutivas poderiam repetir ou pular linhas — o modo mais silencioso de
  -- uma tabela paginada mentir.
  order by f.gross_revenue desc, f.title asc, f.item_id asc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0)
$$;

comment on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer) is
  'Dashboard de anuncios: catalogo real (D-121) com venda, visitas e conversao ja juntadas em SQL, filtros e janela. Devolve total_count do conjunto filtrado para a tela nunca afirmar que mostrou tudo. Substitui a leitura sem paginacao que truncava em 1.000 de 5.085 (D-138).';

revoke all on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer) from public, anon;
grant execute on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer) to authenticated, service_role;
