-- ============================================================
-- D-356 -- A comissao do Mercado Livre e POR UNIDADE.
--
-- `order_items.sale_fee` e a tarifa de UMA unidade (`docs/MERCADO_LIVRE.md`,
-- "tarifa por unidade"), e as duas leituras que a somavam trataram o valor
-- como tarifa do item inteiro: `sum(oi.sale_fee)`, sem multiplicar pela
-- quantidade.
--
-- MEDIDO em producao, 15/09/2026, pedidos validos dos ultimos 30 dias:
--
--   | itens                  | sale_fee / unit_price | sale_fee / (unit_price * quantity) |
--   |------------------------|-----------------------|------------------------------------|
--   | quantity = 1           | 10,39%                | 10,39%                             |
--   | quantity > 1 (393)     | 10,34%                |  4,71%                             |
--
-- A proporcao sobre o preco UNITARIO e a mesma nos dois grupos; sobre o total
-- do item, cai pela metade quando ha mais de uma unidade. `taxas_ml` estava
-- subestimada nos itens com quantidade > 1: R$ 305.257,66 somados contra
-- R$ 308.221,43 multiplicados, em 30 dias.
--
-- O ID da metrica NAO muda (METRICS.md secao 6): o significado continua sendo
-- "comissao de venda"; o que estava errado era a conta. O impacto no numero
-- historico fica registrado na D-356.
--
-- As duas definicoes abaixo sao as vigentes (20260910230000 e 20260903190307)
-- com UMA mudanca cada: `sale_fee` vira `sale_fee * quantity`. Assinaturas,
-- recortes, comentarios e grants sao os mesmos.
--
-- ------------------------------------------------------------
-- E O DESCONTO JA ESTA DENTRO DO PRECO -- a margem o tirava duas vezes
--
-- `get_sales_margin_summary` (D-166) subtraia `seller_discount` da receita.
-- MEDIDO em producao (15/09/2026, pedidos de 10 dias com frete observado):
--
--   - 6.470 de 6.578 pedidos tem `seller_discount` > 0, em media 42,4% da
--     receita; ha pedido com desconto MAIOR que o preco (57,13 de preco,
--     93,58 de desconto). E o desconto contra o preco de TABELA;
--   - a comissao da 10,63% do `unit_price` nesses pedidos (11,90% nos sem
--     desconto) e so 8,16% de `unit_price + desconto`: o ML cobra a tarifa
--     sobre o preco efetivamente vendido, que ja e o `unit_price`.
--
-- A formula oficial (`docs/MERCADO_LIVRE.md` 2.15) e
-- `(unit_price * quantity) - marketplace_fee - seller.cost`: sem desconto. A
-- margem passa a ser receita - comissao - frete, e a cobertura so exige o
-- frete observado. O desconto continua devolvido, como INFORMACAO.
-- ============================================================

create or replace function public.get_sales_expanded_summary(
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
  pedidos as materialized (
    select o.id, o.organization_id, o.ml_account_id, o.status, o.total_amount
    from public.orders o
    cross join bounds b
    where o.date_created >= b.ts_from
      and o.date_created < b.ts_to
      and (p_ml_account_id is null or o.ml_account_id = p_ml_account_id)
  ),
  fees as (
    -- D-356: a tarifa e por unidade.
    select coalesce(round(sum(oi.sale_fee * oi.quantity), 2), 0) as taxas_ml
    from pedidos p
    join public.order_items oi
      on oi.order_id = p.id
     and oi.organization_id = p.organization_id
     and oi.ml_account_id = p.ml_account_id
    where p.status in ('paid', 'partially_refunded')
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
      count(*) filter (where p.status in ('cancelled', 'pending_cancel')) as pedidos_cancelados,
      count(*) filter (where p.status in ('paid', 'partially_refunded')) as pedidos_validos,
      coalesce(round(sum(p.total_amount) filter (where p.status in ('cancelled', 'pending_cancel')), 2), 0) as valor_cancelado
    from pedidos p
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
  'Numeros expandidos de vendas (D-165; marca desde D-237; uma passada por orders desde D-306; comissao por unidade desde D-356). taxas_ml e skus_distintos_vendidos aceitam recorte de marca -- o primeiro sai de order_items.sale_fee * quantity, o segundo e contagem distinta no grao SKU. O trio de cancelamento volta NULL sob recorte: sao contagem distinta e soma de orders.total_amount, do pedido inteiro, e nao ha cota de marca. security invoker.';

revoke all on function public.get_sales_expanded_summary(date, date, uuid, text, boolean) from public, anon;
grant execute on function public.get_sales_expanded_summary(date, date, uuid, text, boolean) to authenticated, service_role;

create or replace function public.get_sales_margin_summary(
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
    -- D-356: so o frete decide a cobertura; o desconto ja esta no preco.
    where f.seller_shipping_cost is not null
  ),
  fees as (
    -- D-356: a tarifa e por unidade.
    select coalesce(sum(oi.sale_fee * oi.quantity), 0) as taxas
    from public.order_items oi
    join covered c on oi.order_id = c.id
  ),
  totals as (
    select count(*) as n,
           coalesce(round(sum(c.total_amount), 2), 0) as gross,
           coalesce(round(sum(c.seller_shipping_cost), 2), 0) as frete,
           -- Informativo (D-356): soma so o que foi observado.
           round(sum(c.seller_discount), 2) as desconto
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
         then round(totals.gross - fees.taxas - totals.frete, 2) end as margem_operacional
  from fees, totals, recorte r
$$;

comment on function public.get_sales_margin_summary(date, date, uuid, text, boolean) is
  'Margem operacional por pedido (D-166; marca desde D-237; D-356: comissao por unidade e desconto fora da subtracao, porque ja esta no preco): receita_bruta - taxas_ml - frete_vendedor, SO sobre pedidos com frete observado, com a cobertura devolvida junto; desconto_vendedor e informativo. Zero cobertura = NULL. Sob recorte de marca volta tudo NULL: frete e desconto sao do pedido. NAO e receita liquida (METRICS 5C.1). security invoker.';

revoke all on function public.get_sales_margin_summary(date, date, uuid, text, boolean) from public, anon;
grant execute on function public.get_sales_margin_summary(date, date, uuid, text, boolean) to authenticated, service_role;

-- O catalogo acompanha o calculo na MESMA migration (METRICS.md secao 6).
-- O UPDATE mora DENTRO do bloco: `found` so enxerga o comando anterior do
-- proprio bloco, e um UPDATE solto antes dele deixaria a guarda sempre falsa.
do $$
begin
  update public.metric_definitions
  set formula = 'SUM(order_items.sale_fee * order_items.quantity) sobre vendas válidas',
      source = 'order_items.sale_fee, a tarifa de UMA unidade (100% preenchido, medido em D-120; por unidade, medido em D-356)',
      definition_updated_on = date '2026-09-15'
  where id = 'taxas_ml';

  if not found then
    raise exception 'metric_definitions sem a linha taxas_ml';
  end if;

  update public.metric_definitions
  set formula = 'receita_bruta − taxas_ml − frete_vendedor, sobre pedidos com frete observado',
      inclusions = 'Só pedidos válidos com o frete observado; receita e taxas do mesmo subconjunto; cobertura sempre declarada ao lado. O desconto bancado pelo vendedor NÃO é subtraído: já está dentro de order_items.unit_price (medido em D-356).',
      definition_updated_on = date '2026-09-15'
  where id = 'margem_operacional_pedido';

  if not found then
    raise exception 'metric_definitions sem a linha margem_operacional_pedido';
  end if;

  update public.metric_definitions
  set inclusions = 'Pedidos válidos com o desconto OBSERVADO. É o desconto contra o preço de tabela e já está dentro do preço vendido (unit_price): informativo, nunca subtraído da receita (D-356).',
      definition_updated_on = date '2026-09-15'
  where id = 'desconto_vendedor';
end;
$$;
