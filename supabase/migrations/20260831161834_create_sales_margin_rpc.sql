-- ============================================================
-- Margem operacional por pedido (D-166) — a última métrica do item de
-- Vendas (METRICS 5C.2), agora que as fontes existem (D-165).
--
-- O contrato de honestidade é o desenho inteiro:
--
-- 1. **Computada SÓ sobre pedidos COBERTOS** — os que têm frete E desconto
--    OBSERVADOS (os dois não-nulos em order_financials). Misturar cobertos
--    com não-cobertos subestimaria custo (receita entraria sem o custo
--    correspondente). Receita e taxas saem do MESMO subconjunto.
-- 2. **Cobertura DECLARADA**: orders_covered ÷ orders_total viaja na
--    resposta e a tela a exibe ao lado do número — nunca uma margem sobre
--    fração silenciosa do período.
-- 3. **Zero cobertura = NULL em tudo** — recusa como contrato (D-144/D-147),
--    nunca R$ 0,00 fingido.
-- 4. **Não é receita líquida** (5C.1): taxa fixa por pedido, parcelamento,
--    custo de cobrança do Mercado Pago, impostos retidos e reembolsos
--    posteriores NÃO entram — a tela lista isso ao lado do valor.
-- ============================================================

create function public.get_sales_margin_summary(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null
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
  with bounds as (
    select (p_date_from::timestamp at time zone 'America/Sao_Paulo') as ts_from,
           ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo') as ts_to
  ),
  valid_orders as (
    select o.id, o.total_amount
    from public.orders o
    cross join bounds b
    where o.date_created >= b.ts_from
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
    (select count(*) from valid_orders)::bigint as orders_total,
    totals.n::bigint as orders_covered,
    case when totals.n = 0 then null else totals.gross end as gross_revenue_covered,
    case when totals.n = 0 then null else round(fees.taxas, 2) end as taxas_ml_covered,
    case when totals.n = 0 then null else totals.frete end as frete_vendedor,
    case when totals.n = 0 then null else totals.desconto end as desconto_vendedor,
    case when totals.n = 0 then null else round(totals.gross - fees.taxas - totals.frete - totals.desconto, 2) end as margem_operacional
  from totals, fees
$$;

comment on function public.get_sales_margin_summary(date, date, uuid) is
  'Margem operacional por pedido (D-166, METRICS 5C.2) — computada SÓ sobre pedidos com frete e desconto OBSERVADOS, com cobertura declarada na resposta. NÃO é receita líquida (5C.1). Zero cobertura devolve NULL, nunca zero fingido. security invoker: RLS filtra antes da soma.';

revoke all on function public.get_sales_margin_summary(date, date, uuid) from public, anon;
grant execute on function public.get_sales_margin_summary(date, date, uuid) to authenticated, service_role;

-- Catálogo (espelho de METRICS 5C.2): a margem e os dois componentes que
-- D-165 passou a observar — todo número na tela carrega o próprio ID.
insert into public.metric_definitions (
  id, name, formula, source, granularities, inclusions, exclusions,
  cancellation_treatment, timezone, definition_updated_on
)
values
  (
    'margem_operacional_pedido',
    'Margem operacional',
    'receita_bruta − taxas_ml − frete_vendedor − desconto_vendedor, sobre pedidos COBERTOS',
    'orders + order_items.sale_fee + order_financials (D-165); cobertura = pedidos com frete E desconto observados ÷ pedidos válidos',
    array['account', 'organization'],
    'Só pedidos válidos com os DOIS custos observados; receita e taxas do mesmo subconjunto; cobertura sempre declarada ao lado.',
    'NÃO é receita líquida (5C.1): taxa fixa por pedido, parcelamento, custo de cobrança do Mercado Pago, impostos retidos e reembolsos posteriores ficam fora — lacunas da própria documentação oficial.',
    'excluded',
    'America/Sao_Paulo',
    date '2026-08-31'
  ),
  (
    'frete_vendedor',
    'Frete do vendedor',
    'SUM(order_financials.seller_shipping_cost) sobre pedidos cobertos',
    'GET /shipments/{id}/costs → senders[].cost somado (§2.15, campo designado pela FAQ para conciliação), persistido por D-165',
    array['account', 'organization'],
    'Pedidos válidos com o custo OBSERVADO.',
    'Pedido sem observação (NULL) fica fora — nunca tratado como R$ 0,00.',
    'excluded',
    'America/Sao_Paulo',
    date '2026-08-31'
  ),
  (
    'desconto_vendedor',
    'Desconto bancado pelo vendedor',
    'SUM(order_financials.seller_discount) sobre pedidos cobertos',
    'GET /orders/{id}/discounts → amounts.seller (§2.15), persistido por D-165',
    array['account', 'organization'],
    'Pedidos válidos com o desconto OBSERVADO.',
    'Taxas adicionais e reembolsos posteriores (exclusão da própria doc); pedido sem observação fica fora.',
    'excluded',
    'America/Sao_Paulo',
    date '2026-08-31'
  );
