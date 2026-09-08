-- ============================================================
-- `p_sold` em `get_listings_dashboard` -- a celula "Vendidos sem vinculo" do
-- frame `ProcessScreen type="links"` (D21, D-259).
--
-- POR QUE UM ARGUMENTO E NAO UMA CONTAGEM A PARTE. A regra de D-242: **uma
-- celula de resumo so existe se o predicado dela existir na funcao que monta
-- a LISTA**, e o link da celula aplica esse mesmo predicado. Uma contagem
-- propria seria um segundo dono do numero (D-224), e e assim que faixa e
-- tabela comecam a discordar.
--
-- "Vendidos sem vinculo" e a intersecao de dois predicados que agora existem
-- os dois: `p_link_state = 'unlinked'` (que ja havia) e `p_sold = 'with'`
-- (este). Nenhum numero novo e inventado -- a celula e um recorte da mesma
-- consulta.
--
-- MEDIDO no Dev antes de escrever, janela de 30 dias:
--
--   anuncios                      5.089
--   vinculados                    4.226   <- 1.013 deles POR VARIACAO
--   sem vinculo                     863
--   **vendidos sem vinculo**        337   <- a celula que este argumento serve
--   candidatos pendentes              0
--
-- **Os 337 sao o numero acionavel da tela**: anuncio que vendeu nos ultimos
-- 30 dias e nao tem SKU ligado e receita entrando sem baixa de estoque.
--
-- E o 863 so esta certo por causa de D-122: contar `sku_id is null` daria
-- **1.876**, porque 1.013 anuncios tem vinculo POR VARIACAO com `sku_id`
-- nulo. Mais que o dobro.
--
-- ------------------------------------------------------------
-- ASSINATURA: conferida nas duas metades antes de escrever (D-237)
-- ------------------------------------------------------------
--   catalogo   nenhuma funcao SQL chama `get_listings_dashboard`
--   monorepo   `apps/web/app/anuncios/page.tsx`, `.../[itemId]/page.tsx` e a
--              suite de integracao -- todos por NOME de argumento no
--              TypeScript, e por POSICAO no SQL dos testes
--
-- Por isso `p_sold` entra por ULTIMO: quem nao o passa continua igual, e as
-- chamadas posicionais existentes nao se deslocam (licao de D-242).
--
-- O corpo abaixo e o que ja estava no ar, EXTRAIDO DO ARQUIVO da migration
-- anterior e nao transcrito a mao; a fatia acrescenta um argumento e um
-- `case` no `where`, e nao toca em mais nada.
-- ============================================================

drop function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text);

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
  p_full text default 'all',
  -- 'all' | 'with' | 'without' — houve VENDA na janela (D-259). Entra por
  -- ultimo, pelo mesmo motivo de p_stock e p_full.
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

comment on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text) is
  'Dashboard de /anuncios (D-138), com Full por anuncio (D-243) e venda na janela (D-259). p_link_state NAO e sku_id is null: 1.013 anuncios tem vinculo POR VARIACAO (D-122), e conta-los como sem vinculo dobraria o numero. p_sold (all|with|without) existe para a celula "Vendidos sem vinculo" da Integridade de Catalogo sair do MESMO predicado da lista (D-242) -- 337 medidos no Dev em 30 dias. Ausencia de metrica de venda E ausencia de venda, entao o coalesce para zero e correto aqui (diferente do Full, D-067). Argumentos novos entram no FIM da assinatura. security invoker.';

revoke all on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text) from public, anon;
grant execute on function public.get_listings_dashboard(uuid, date, date, uuid, text, text, text, integer, integer, text, text, text) to authenticated, service_role;
