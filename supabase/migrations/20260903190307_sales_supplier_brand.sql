-- ============================================================
-- Filtro de MARCA no Dashboard de Vendas (D-237) -- ultima parte do item P1
-- "filtros de Conta / Origem / Marca nas telas em que fizerem sentido".
-- Antes: Curva ABC (D-235) e Cobertura (D-236).
--
-- Esta e a mais dificil das tres, e a dificuldade nao e SQL: e que **nem todo
-- numero de vendas tem versao por marca**. O que segue esta medido no Dev.
--
-- ------------------------------------------------------------
-- 1. O QUE DECOMPOE POR MARCA, E O QUE NAO DECOMPOE
-- ------------------------------------------------------------
-- **Receita e unidades decompoem, e isso foi PROVADO, nao suposto:**
--
--   sum(orders.total_amount)            R$ 3.073.580,78
--   sum(order_items.quantity*unit_price) R$ 3.073.580,78   <- identico
--
-- Entao a fatia de uma marca e uma parcela legitima do total.
--
-- **`purchases_count` NAO decompoe, e a propria migration que criou as
-- metricas ja dizia** (`20260821182620`):
--
--   "Medidas distintas sao calculadas diretamente em cada grao pelo mesmo
--    GROUPING SETS. Em especial, purchases_count NAO E A SOMA da contagem por
--    anuncio: pedidos do mesmo pack podem pertencer a anuncios diferentes."
--
-- Medido: somando `daily_sku_metrics.purchases_count` por (conta, dia) contra
-- `daily_account_metrics`, **48 de 124 pares divergem so em agosto/2026**, e
-- sempre com o grao fino somando MAIS -- a assinatura de contar o mesmo pack
-- em dois SKUs. `average_ticket` (receita / compras) herda o problema.
--
-- **Frete e desconto do vendedor sao do PEDIDO**, nao do item: nao existe
-- "cota de frete da marca X". A margem inteira fica de fora.
--
-- **A decisao, tomada com o usuario:** o filtro entra, e o que nao tem
-- resposta certa por marca volta **NULL** -- nunca um numero plausivel e
-- errado. E o mesmo contrato de `days_of_coverage` para estoque virtual
-- (D-127): *"sem saldo real, um numero aqui seria resposta errada com cara de
-- precisa"*.
--
-- ------------------------------------------------------------
-- 2. AS DUAS PRIMEIRAS RPCs TROCAM DE FONTE -- SO QUANDO HA FILTRO
-- ------------------------------------------------------------
-- `get_sales_summary` e `get_sales_daily_series` leem `daily_account_metrics`,
-- que **nao tem dimensao de SKU** -- nao ha marca la. A fonte fina
-- (`daily_sku_metrics`) tem, e as duas RECONCILIAM: 376 pares (conta, dia) na
-- janela pos-junho, **zero divergencia** em receita, unidades e pedidos (o
-- unico que diverge e `purchases_count`, que e justamente o que vira NULL).
--
-- Mas trocar a fonte SEMPRE seria regressao na tela mais usada:
--
--   daily_account_metrics   0,378 ms    133 buffers
--   daily_sku_metrics       7,0   ms    830 buffers   <- 18x
--
-- E `/vendas` chama cada RPC **duas vezes** (periodo atual e comparativo).
-- Por isso e `union all` com guardas mutuamente exclusivas: sem filtro, o
-- ramo do grao fino nao entra. **Conferido no plano** -- com marca nula o
-- EXPLAIN volta identico ao de hoje (133 buffers, 0,384 ms) e o segundo ramo
-- **nao aparece**.
--
-- ------------------------------------------------------------
-- 3. "SEM MARCA" E VALOR DE FILTRO, NAO ESQUECIMENTO
-- ------------------------------------------------------------
-- **23,2% da receita (R$ 707.937 em 30 dias) esta em itens SEM `sku_id`** --
-- venda que nenhuma marca alcanca. Se o filtro so listasse as 19 marcas, quem
-- somasse todas nao chegaria ao total e um quarto do faturamento sumiria sem
-- explicacao.
--
-- `p_sem_marca` e um parametro PROPRIO em vez de um valor magico em
-- `p_supplier_brand`: string reservada colidiria com marca real e exigiria a
-- mesma constante repetida em SQL e TypeScript -- as "duas listas" que D-232
-- puniu. Quando `p_sem_marca` e verdadeiro, `p_supplier_brand` e ignorado.
--
-- ------------------------------------------------------------
-- 4. PARAMETROS NO FIM (licao de D-235/D-236)
-- ------------------------------------------------------------
-- Perguntado ao catalogo ANTES de escrever: nenhuma das cinco tem chamador
-- dentro do banco (`select proname from pg_proc where prosrc like '%get_sales_%'`
-- -> nenhum). Mesmo assim os parametros vao no fim, para a convencao ser a
-- mesma nas tres fatias do item.
-- ============================================================

-- ------------------------------------------------------------
-- 1/5 -- get_sales_summary
-- ------------------------------------------------------------
drop function public.get_sales_summary(date, date, uuid);

create function public.get_sales_summary(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_supplier_brand text default null,
  p_sem_marca boolean default false
)
returns table (
  units_sold bigint,
  gross_revenue numeric,
  orders_count bigint,
  purchases_count bigint,
  average_ticket numeric,
  average_selling_price numeric,
  last_computed_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with escopo as (
    -- Ramo SEM recorte de marca: a fonte de sempre, plano identico ao de antes.
    select m.units_sold, m.gross_revenue, m.orders_count, m.purchases_count, m.computed_at
    from public.daily_account_metrics m
    where p_supplier_brand is null and not p_sem_marca
      and m.metric_date between p_date_from and p_date_to
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)

    union all

    -- Ramo COM recorte: grao fino, que e o unico que conhece SKU e marca.
    select m.units_sold, m.gross_revenue, m.orders_count, m.purchases_count, m.computed_at
    from public.daily_sku_metrics m
    where (p_supplier_brand is not null or p_sem_marca)
      and m.metric_date between p_date_from and p_date_to
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
      and (
        case when p_sem_marca
          -- "Sem marca" e a venda que nenhuma marca alcanca: item sem SKU, ou
          -- SKU sem marca cadastrada.
          then m.sku_id is null
               or not exists (select 1 from public.skus s
                              where s.id = m.sku_id and s.supplier_brand is not null)
          else exists (select 1 from public.skus s
                       where s.id = m.sku_id and s.supplier_brand = p_supplier_brand)
        end
      )
  )
  select
    coalesce(sum(e.units_sold), 0)::bigint as units_sold,
    coalesce(round(sum(e.gross_revenue), 2), 0) as gross_revenue,
    coalesce(sum(e.orders_count), 0)::bigint as orders_count,
    -- NULL com recorte, e a razao esta na secao 1: somar contagem distinta
    -- entre graos conta o mesmo pack duas vezes.
    case when p_supplier_brand is null and not p_sem_marca
         then coalesce(sum(e.purchases_count), 0)::bigint end as purchases_count,
    case when p_supplier_brand is null and not p_sem_marca
         then round(sum(e.gross_revenue) / nullif(sum(e.purchases_count), 0), 2) end as average_ticket,
    -- Receita / unidades: os dois lados sao aditivos, entao este sobrevive.
    round(sum(e.gross_revenue) / nullif(sum(e.units_sold), 0), 2) as average_selling_price,
    max(e.computed_at) as last_computed_at
  from escopo e
$$;

comment on function public.get_sales_summary(date, date, uuid, text, boolean) is
  'Resumo de vendas do periodo (Fase 5A; marca desde D-237). SEM recorte de marca le daily_account_metrics, o plano de sempre. COM recorte troca para daily_sku_metrics -- as duas reconciliam (376 pares, zero divergencia em receita/unidades/pedidos). purchases_count e average_ticket voltam NULL sob recorte de proposito: purchases_count e contagem DISTINTA de pack e nao e a soma do grao fino (dito na migration 20260821182620 e medido: 48 de 124 pares divergem em agosto/2026). p_sem_marca isola a venda sem SKU -- 23,2% da receita. security invoker.';

revoke all on function public.get_sales_summary(date, date, uuid, text, boolean) from public, anon;
grant execute on function public.get_sales_summary(date, date, uuid, text, boolean) to authenticated, service_role;

-- ------------------------------------------------------------
-- 2/5 -- get_sales_daily_series
-- ------------------------------------------------------------
drop function public.get_sales_daily_series(date, date, uuid);

create function public.get_sales_daily_series(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_supplier_brand text default null,
  p_sem_marca boolean default false
)
returns table (
  metric_date date,
  units_sold bigint,
  gross_revenue numeric,
  orders_count bigint,
  purchases_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with escopo as (
    select m.metric_date, m.units_sold, m.gross_revenue, m.orders_count, m.purchases_count
    from public.daily_account_metrics m
    where p_supplier_brand is null and not p_sem_marca
      and m.metric_date between p_date_from and p_date_to
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)

    union all

    select m.metric_date, m.units_sold, m.gross_revenue, m.orders_count, m.purchases_count
    from public.daily_sku_metrics m
    where (p_supplier_brand is not null or p_sem_marca)
      and m.metric_date between p_date_from and p_date_to
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
      and (
        case when p_sem_marca
          then m.sku_id is null
               or not exists (select 1 from public.skus s
                              where s.id = m.sku_id and s.supplier_brand is not null)
          else exists (select 1 from public.skus s
                       where s.id = m.sku_id and s.supplier_brand = p_supplier_brand)
        end
      )
  )
  select
    e.metric_date,
    sum(e.units_sold)::bigint as units_sold,
    round(sum(e.gross_revenue), 2) as gross_revenue,
    sum(e.orders_count)::bigint as orders_count,
    case when p_supplier_brand is null and not p_sem_marca
         then sum(e.purchases_count)::bigint end as purchases_count
  from escopo e
  group by e.metric_date
  order by e.metric_date
$$;

comment on function public.get_sales_daily_series(date, date, uuid, text, boolean) is
  'Serie diaria de vendas (Fase 5A; marca desde D-237). Mesma troca de fonte condicional de get_sales_summary, e purchases_count volta NULL sob recorte pela mesma razao (contagem distinta de pack nao soma entre graos). security invoker.';

revoke all on function public.get_sales_daily_series(date, date, uuid, text, boolean) from public, anon;
grant execute on function public.get_sales_daily_series(date, date, uuid, text, boolean) to authenticated, service_role;

-- ------------------------------------------------------------
-- 3/5 -- get_sales_today_summary
--
-- Aqui a fonte ja e `orders`/`order_items`, entao nao ha troca de fonte: o
-- recorte entra restringindo os ITENS a marca. Receita passa a sair de
-- `quantity * unit_price` (a decomposicao provada na secao 1) em vez de
-- `orders.total_amount`, que e do pedido inteiro e nao tem cota de marca.
-- ------------------------------------------------------------
drop function public.get_sales_today_summary(date, uuid);

create function public.get_sales_today_summary(
  p_date date,
  p_ml_account_id uuid default null,
  p_supplier_brand text default null,
  p_sem_marca boolean default false
)
returns table (
  units_sold bigint,
  gross_revenue numeric,
  orders_count bigint,
  purchases_count bigint,
  last_order_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with bounds as (
    -- Mesma expressão de dia civil America/Sao_Paulo do recálculo canônico.
    select (p_date::timestamp at time zone 'America/Sao_Paulo') as ts_from,
           ((p_date + 1)::timestamp at time zone 'America/Sao_Paulo') as ts_to
  ),
  valid_orders as (
    select o.id, o.pack_id, o.total_amount, o.date_created
    from public.orders o
    cross join bounds b
    where o.date_created >= b.ts_from
      and o.date_created < b.ts_to
      and o.status in ('paid', 'partially_refunded')
      and (p_ml_account_id is null or o.ml_account_id = p_ml_account_id)
  ),
  itens as (
    -- So os itens do recorte. Sem recorte, TODOS -- e ai a receita continua
    -- vindo de `orders`, como antes.
    select oi.order_id, oi.quantity, oi.unit_price
    from public.order_items oi
    join valid_orders v on oi.order_id = v.id
    where (p_supplier_brand is null and not p_sem_marca)
       or (
         case when p_sem_marca
           then oi.sku_id is null
                or not exists (select 1 from public.skus s
                               where s.id = oi.sku_id and s.supplier_brand is not null)
           else exists (select 1 from public.skus s
                        where s.id = oi.sku_id and s.supplier_brand = p_supplier_brand)
         end
       )
  ),
  units as (
    select coalesce(sum(i.quantity), 0)::bigint as units_sold from itens i
  ),
  totals as (
    -- Sem recorte: receita/pedidos/compras contados nas ORDERS, imune a pedido
    -- com mais de um item duplicar total_amount (contrato original).
    select
      coalesce(round(sum(v.total_amount), 2), 0) as gross_revenue,
      count(distinct v.id)::bigint as orders_count,
      count(distinct case when v.pack_id is null then 'order:' || v.id::text else 'pack:' || v.pack_id::text end)::bigint as purchases_count,
      max(v.date_created) as last_order_at
    from valid_orders v
  ),
  totals_marca as (
    -- Com recorte: receita pela decomposicao em itens; pedidos = os que TEM
    -- item da marca. `purchases_count` fica de fora -- ver secao 1.
    select
      coalesce(round(sum(i.quantity * i.unit_price), 2), 0) as gross_revenue,
      count(distinct i.order_id)::bigint as orders_count,
      (select max(v.date_created) from valid_orders v
        where exists (select 1 from itens i2 where i2.order_id = v.id)) as last_order_at
    from itens i
  )
  select
    units.units_sold,
    case when p_supplier_brand is null and not p_sem_marca
         then totals.gross_revenue else totals_marca.gross_revenue end as gross_revenue,
    case when p_supplier_brand is null and not p_sem_marca
         then totals.orders_count else totals_marca.orders_count end as orders_count,
    case when p_supplier_brand is null and not p_sem_marca
         then totals.purchases_count end as purchases_count,
    case when p_supplier_brand is null and not p_sem_marca
         then totals.last_order_at else totals_marca.last_order_at end as last_order_at
  from units, totals, totals_marca
$$;

comment on function public.get_sales_today_summary(date, uuid, text, boolean) is
  'Vendas do dia corrente (D-165; marca desde D-237). Sem recorte, receita/pedidos/compras vem de `orders` como antes. Com recorte, receita vem da decomposicao em itens (quantity*unit_price, que soma exatamente ao total dos pedidos -- medido) e pedidos passam a ser "os que tem item da marca"; purchases_count volta NULL porque pack atravessa SKU. security invoker.';

revoke all on function public.get_sales_today_summary(date, uuid, text, boolean) from public, anon;
grant execute on function public.get_sales_today_summary(date, uuid, text, boolean) to authenticated, service_role;

-- ------------------------------------------------------------
-- 4/5 -- get_sales_expanded_summary
--
-- Dois dos cinco numeros decompoem por marca e tres nao:
--
--   taxas_ml                 sai de `order_items.sale_fee` -- por ITEM, decompoe;
--   skus_distintos_vendidos  contagem distinta NO grao SKU -- decompoe;
--   pedidos_cancelados,
--   taxa_cancelamento,
--   valor_cancelado          contagem distinta em ORDERS, e `valor_cancelado`
--                            usa `orders.total_amount`, do pedido inteiro.
--                            Nao ha cota de marca. -> NULL sob recorte.
-- ------------------------------------------------------------
drop function public.get_sales_expanded_summary(date, date, uuid);

create function public.get_sales_expanded_summary(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_supplier_brand text default null,
  p_sem_marca boolean default false
)
returns table (
  taxas_ml numeric,
  pedidos_cancelados bigint,
  taxa_cancelamento numeric,
  valor_cancelado numeric,
  skus_distintos_vendidos bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with bounds as (
    select (p_date_from::timestamp at time zone 'America/Sao_Paulo') as ts_from,
           ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo') as ts_to
  ),
  recorte as (select (p_supplier_brand is null and not p_sem_marca) as sem_recorte),
  fees as (
    select coalesce(round(sum(oi.sale_fee), 2), 0) as taxas_ml
    from public.orders o
    join public.order_items oi
      on oi.order_id = o.id
     and oi.organization_id = o.organization_id
     and oi.ml_account_id = o.ml_account_id
    cross join bounds b
    where o.date_created >= b.ts_from
      and o.date_created < b.ts_to
      and o.status in ('paid', 'partially_refunded')
      and (p_ml_account_id is null or o.ml_account_id = p_ml_account_id)
      and ((p_supplier_brand is null and not p_sem_marca)
           or (case when p_sem_marca
                 then oi.sku_id is null
                      or not exists (select 1 from public.skus s
                                     where s.id = oi.sku_id and s.supplier_brand is not null)
                 else exists (select 1 from public.skus s
                              where s.id = oi.sku_id and s.supplier_brand = p_supplier_brand)
               end))
  ),
  counts as (
    select
      count(distinct o.id) filter (where o.status in ('cancelled', 'pending_cancel')) as pedidos_cancelados,
      count(distinct o.id) filter (where o.status in ('paid', 'partially_refunded')) as pedidos_validos,
      coalesce(round(sum(o.total_amount) filter (where o.status in ('cancelled', 'pending_cancel')), 2), 0) as valor_cancelado
    from public.orders o
    cross join bounds b
    where o.date_created >= b.ts_from
      and o.date_created < b.ts_to
      and (p_ml_account_id is null or o.ml_account_id = p_ml_account_id)
  ),
  skus as (
    select count(distinct m.sku_id) as skus_distintos_vendidos
    from public.daily_sku_metrics m
    where m.metric_date between p_date_from and p_date_to
      and m.sku_id is not null
      and m.units_sold > 0
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
      and ((p_supplier_brand is null and not p_sem_marca)
           or (case when p_sem_marca
                 then not exists (select 1 from public.skus s
                                  where s.id = m.sku_id and s.supplier_brand is not null)
                 else exists (select 1 from public.skus s
                              where s.id = m.sku_id and s.supplier_brand = p_supplier_brand)
               end))
  )
  select
    fees.taxas_ml,
    case when r.sem_recorte then counts.pedidos_cancelados::bigint end as pedidos_cancelados,
    case when r.sem_recorte
         then round(counts.pedidos_cancelados::numeric / nullif(counts.pedidos_cancelados + counts.pedidos_validos, 0), 4) end as taxa_cancelamento,
    case when r.sem_recorte then counts.valor_cancelado end as valor_cancelado,
    skus.skus_distintos_vendidos::bigint
  from fees, counts, skus, recorte r
$$;

comment on function public.get_sales_expanded_summary(date, date, uuid, text, boolean) is
  'Numeros expandidos de vendas (D-165; marca desde D-237). taxas_ml e skus_distintos_vendidos aceitam recorte de marca -- o primeiro sai de order_items.sale_fee, o segundo e contagem distinta no grao SKU. O trio de cancelamento volta NULL sob recorte: sao contagem distinta e soma de orders.total_amount, do pedido inteiro, e nao ha cota de marca. security invoker.';

revoke all on function public.get_sales_expanded_summary(date, date, uuid, text, boolean) from public, anon;
grant execute on function public.get_sales_expanded_summary(date, date, uuid, text, boolean) to authenticated, service_role;

-- ------------------------------------------------------------
-- 5/5 -- get_sales_margin_summary
--
-- Esta sai INTEIRA sob recorte, e a razao vale para todos os campos:
-- `order_financials.seller_shipping_cost` e `seller_discount` sao do PEDIDO.
-- Nao existe "frete da marca X" -- um pedido tem UM frete, nao um frete por
-- item. `orders_total`/`orders_covered` sao contagens de PEDIDO pelo mesmo
-- motivo.
--
-- Devolver metade da margem seria PIOR que nao devolver nenhuma: a tela
-- mostraria "margem operacional" de um recorte cujo CUSTO nao foi recortado --
-- receita da marca menos frete da operacao inteira. Numero errado com cara de
-- precisa, que e exatamente o que D-127 recusa fazer com cobertura.
-- ------------------------------------------------------------
drop function public.get_sales_margin_summary(date, date, uuid);

create function public.get_sales_margin_summary(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null,
  p_supplier_brand text default null,
  p_sem_marca boolean default false
)
returns table (
  orders_total bigint,
  orders_covered bigint,
  gross_revenue_covered numeric,
  taxas_ml_covered numeric,
  frete_vendedor numeric,
  desconto_vendedor numeric,
  margem_operacional numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with recorte as (select (p_supplier_brand is null and not p_sem_marca) as sem_recorte),
  bounds as (
    select (p_date_from::timestamp at time zone 'America/Sao_Paulo') as ts_from,
           ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo') as ts_to
  ),
  valid_orders as (
    -- Com recorte a CTE fica vazia de proposito: nao ha o que somar, e o
    -- `case` do select final devolve NULL em todos os campos.
    select o.id, o.total_amount
    from public.orders o
    cross join bounds b
    where (select sem_recorte from recorte)
      and o.date_created >= b.ts_from
      and o.date_created < b.ts_to
      and o.status in ('paid', 'partially_refunded')
      and (p_ml_account_id is null or o.ml_account_id = p_ml_account_id)
  ),
  covered as (
    select v.id, v.total_amount, f.seller_shipping_cost, f.seller_discount
    from valid_orders v
    join public.order_financials f on f.order_id = v.id
    where f.seller_shipping_cost is not null
      and f.seller_discount is not null
  ),
  fees as (
    select coalesce(sum(oi.sale_fee), 0) as taxas
    from public.order_items oi
    join covered c on oi.order_id = c.id
  ),
  totals as (
    select count(*) as n,
           coalesce(round(sum(c.total_amount), 2), 0) as gross,
           coalesce(round(sum(c.seller_shipping_cost), 2), 0) as frete,
           coalesce(round(sum(c.seller_discount), 2), 0) as desconto
    from covered c
  )
  select
    case when r.sem_recorte then (select count(*) from valid_orders)::bigint end as orders_total,
    case when r.sem_recorte then totals.n::bigint end as orders_covered,
    case when r.sem_recorte and totals.n > 0 then totals.gross end as gross_revenue_covered,
    case when r.sem_recorte and totals.n > 0 then round(fees.taxas, 2) end as taxas_ml_covered,
    case when r.sem_recorte and totals.n > 0 then totals.frete end as frete_vendedor,
    case when r.sem_recorte and totals.n > 0 then totals.desconto end as desconto_vendedor,
    case when r.sem_recorte and totals.n > 0
         then round(totals.gross - fees.taxas - totals.frete - totals.desconto, 2) end as margem_operacional
  from fees, totals, recorte r
$$;

comment on function public.get_sales_margin_summary(date, date, uuid, text, boolean) is
  'Margem operacional observada (D-167; marca desde D-237). SOB RECORTE DE MARCA VOLTA TUDO NULL, de proposito: seller_shipping_cost e seller_discount sao do PEDIDO -- um pedido tem um frete, nao um frete por item. Devolver margem de um recorte cujo custo nao foi recortado seria numero errado com cara de precisa. security invoker.';

revoke all on function public.get_sales_margin_summary(date, date, uuid, text, boolean) from public, anon;
grant execute on function public.get_sales_margin_summary(date, date, uuid, text, boolean) to authenticated, service_role;
