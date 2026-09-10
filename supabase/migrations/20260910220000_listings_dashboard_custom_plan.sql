-- ============================================================
-- `/anuncios` estourava o `statement_timeout`, e a causa era o PLANO -- nao
-- a consulta, nao a RLS, nao a janela `count(*) over ()` (D-305).
--
-- O sintoma: "Nao foi possivel carregar: canceling statement due to
-- statement timeout", com as seis celulas da faixa em "--".
--
-- ------------------------------------------------------------
-- O QUE FOI MEDIDO, NA ORDEM EM QUE ELIMINOU HIPOTESE
-- ------------------------------------------------------------
--
-- Tudo no Dev, em 2026-09-10, como `authenticated` real (RLS ligada,
-- `luiz@speedbikers.com`, ANALISTA, 4 contas):
--
--   o CORPO da funcao, com os mesmos parametros              228 ms
--   a FUNCAO, com os mesmos parametros                   > 60.000 ms
--
-- O mesmo SQL. A diferenca nao esta no que se pergunta.
--
-- Hipoteses que a medicao DERRUBOU, e vale registrar porque cada uma tinha
-- precedente nesta base:
--
--   `count(*) over ()`   o `WindowAgg` custa **2 ms** dos 567 do corpo. Era a
--                        suspeita principal, pelo precedente de D-167, e
--                        estava errada. A janela nao e o problema aqui.
--   RLS por linha        o defeito de D-181. Nao voltou: TODA policy aparece
--                        como `hashed SubPlan` com `rows=4 loops=1`.
--   volume de dados      os CTEs isolados custam 27 ms (Full), 17 ms
--                        (visitas), 102 ms (metricas).
--   plano generico do
--   plancache            `set plan_cache_mode = force_custom_plan` na SESSAO
--                        nao muda nada -- ele nao alcanca corpo de funcao SQL.
--
-- ------------------------------------------------------------
-- A CAUSA
-- ------------------------------------------------------------
--
-- No PostgreSQL 17, o corpo de uma funcao `language sql` e planejado UMA vez,
-- **sem os valores dos argumentos**. E funcao com clausula `SET` (aqui,
-- `search_path = ''`) nunca e inlined -- entao nao ha como o planejador ver os
-- valores. O corpo roda sempre com o plano GENERICO.
--
-- E o plano generico erra as estimativas por duas ordens de grandeza, porque
-- `metric_date between $2 and $3` com parametro cai no padrao de 0,5% do
-- Postgres, e `($4 is null or coluna = $4)` idem:
--
--   metricas_dia            137 estimadas   13.799 reais
--   seq scan em listings     66 estimadas    5.089 reais
--   visitas                  84 estimadas    3.477 reais
--
-- Estimando ~1 linha em todo lugar, ele troca os hash joins por **nested
-- loops**, e o `GroupAggregate` de `visitas` -- que agrega 34.502 linhas --
-- fica do lado interno SEM `Materialize`: reexecutado uma vez por linha de
-- `listings`. Cinco mil vezes.
--
-- E o plano generico **parece mais barato** (custo estimado 9.961 contra
-- 11.989 do custom), justamente porque as estimativas estao erradas. Por isso
-- o Postgres o escolhe e nunca mais volta atras.
--
-- ------------------------------------------------------------
-- O CONSERTO, E POR QUE ELE E DUAS COISAS E NAO UMA
-- ------------------------------------------------------------
--
-- `language plpgsql` faz o corpo passar pelo SPI, que aceita plano custom.
-- `set plan_cache_mode = 'force_custom_plan'` impede o SPI de migrar para o
-- generico depois da quinta execucao.
--
-- **As duas sao necessarias, e ha ensaio de controle provando:**
--
--   plpgsql COM o `set`, 8 execucoes seguidas:
--     220, 201, 199, 199, 199, 219, 234, 200 ms   -- sem degradacao
--
--   plpgsql SEM o `set`, mesmas 8:
--     execucoes 1 a 5 custaram ~200 ms cada; a **sexta** consumiu os 99 s
--     restantes do orcamento e foi cancelada. E exatamente a troca do plano.
--
-- Os dois ensaios rodaram em funcao de nome proprio, dentro de transacao
-- REVERTIDA -- nada foi criado no Dev para medir.
--
-- ------------------------------------------------------------
-- O QUE **NAO** MUDA
-- ------------------------------------------------------------
--
-- A assinatura, os 12 argumentos na mesma ordem, o tipo de retorno, o
-- `security invoker`, o `search_path = ''`, o `stable`, e o SQL do corpo --
-- que foi extraido do arquivo de `20260907160000_listings_sold_predicate.sql`,
-- nao transcrito a mao.
--
-- UMA alteracao textual foi obrigatoria: `returns table (...)` transforma cada
-- coluna de saida em VARIAVEL do plpgsql, e o CTE `filtrado` referenciava
-- `link_state` sem qualificar -- que colide com a variavel homonima. Passou a
-- ser `base.link_state`. O padrao do plpgsql e `variable_conflict = error`, de
-- proposito mantido: qualquer colisao futura falha alto, nao em silencio.
--
-- Resultado conferido no ensaio: as mesmas 50 linhas e o mesmo
-- `total_count` = 5.089.
--
-- ------------------------------------------------------------
-- O ALCANCE, que e maior que esta funcao
-- ------------------------------------------------------------
--
-- `pg_stat_statements` do Dev diz que **toda** RPC acima de 500 ms e
-- `language sql`, e a unica `plpgsql` da lista e a mais rapida:
--
--   get_sales_expanded_summary   sql      media 1.146 ms   pior 7.416 ms
--   get_sku_correlated_events    sql      media 2.248 ms   pior 7.392 ms
--   get_listings_dashboard       sql      media 2.079 ms   pior 5.495 ms
--   get_link_integrity           sql      media   871 ms   pior 5.454 ms
--   ... mais 18, todas sql
--   get_sku_curation             plpgsql  media   200 ms   pior   786 ms
--
-- O teto de `authenticated` e 8 s. Duas ja encostaram nele. Esta fatia
-- conserta a tela que caiu; as outras ficam MEDIDAS e nomeadas aqui, nao
-- consertadas em silencio junto.
-- ============================================================

create or replace function public.get_listings_dashboard(
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
  p_full text default 'all',
  -- 'all' | 'with' | 'without' — houve VENDA na janela (D-259).
  p_sold text default 'all'
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
language plpgsql
stable
security invoker
set search_path = ''
-- A linha que impede a volta do plano generico. Medida: sem ela, a sexta
-- execucao consecutiva sai de 200 ms para dezenas de segundos.
set plan_cache_mode = 'force_custom_plan'
as $fn$
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
    -- — o bucket que o Mercado Livre reparte —, e so dos ultimos 3 dias.
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
         f.full_quantity,
         count(*) over () as total_count
  from filtrado f
  order by f.gross_revenue desc, f.title asc, f.item_id asc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0);
end;
$fn$;

comment on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text) is
  'Dashboard de /anuncios (D-138), com Full por anuncio (D-243) e venda na janela (D-259). p_link_state NAO e sku_id is null: 1.013 anuncios tem vinculo POR VARIACAO (D-122). p_sold (all|with|without) existe para a celula "Vendidos sem vinculo" sair do MESMO predicado da lista (D-242). Ausencia de metrica de venda E ausencia de venda, entao o coalesce para zero e correto aqui (diferente do Full, D-067). plpgsql + force_custom_plan desde D-305: em language sql o corpo era planejado sem os valores dos argumentos, o plano generico errava as estimativas por 100x e trocava hash join por nested loop -- 228 ms viravam mais de 60 s. security invoker.';

revoke all on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text) from public, anon;
grant execute on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text) to authenticated, service_role;
