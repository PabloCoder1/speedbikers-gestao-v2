-- ============================================================
-- Métricas 5C de vendas — a fatia IMPLEMENTÁVEL do item de Vendas (D-157).
--
-- docs/METRICS.md 5C.2 definiu nove métricas ANTES de qualquer tela; cinco
-- têm fonte confirmada e persistida hoje: taxas_ml (order_items.sale_fee,
-- 100% preenchido, medido em D-120), pedidos_cancelados, taxa_cancelamento,
-- valor_cancelado (orders.status/total_amount) e skus_distintos_vendidos
-- (daily_sku_metrics no grão SKU). As demais continuam bloqueadas com o
-- motivo nomeado (5C.1/5C.4): margem_operacional_pedido espera frete e
-- desconto persistidos; valor_estoque espera o ensaio de /produtos; a visão
-- "hoje" tem decisão própria de desenho.
--
-- Por que orders direto (L1) e não o rollup L3: cancelamento NÃO existe em
-- daily_*_metrics (o recálculo filtra paid/partially_refunded por
-- construção). E a taxa de cancelamento é calculada INTEIRA da mesma
-- leitura de orders — misturar cancelados de L1 com válidos de L3
-- embutiria o atraso do recálculo na razão (medido em 2026-08-31:
-- 28.584 em L1 contra 28.556 em L3 na mesma janela, 0,1% de defasagem
-- natural). Volume de 30 dias: ~31k pedidos — agregação em SQL por
-- índice (orders_date_created_idx), EXPLAIN medido em 168 ms / 174k
-- buffers, sem índice novo.
-- ============================================================

create function public.get_sales_expanded_summary(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null
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
    -- Mesma expressão de dia civil America/Sao_Paulo do recálculo canônico
    -- (20260821182620) — janela sargável sobre orders_date_created_idx.
    select (p_date_from::timestamp at time zone 'America/Sao_Paulo') as ts_from,
           ((p_date_to + 1)::timestamp at time zone 'America/Sao_Paulo') as ts_to
  ),
  fees as (
    -- taxas_ml: comissão de venda sobre vendas VÁLIDAS (mesma semântica de
    -- D-050). Não inclui frete, taxa fixa, parcelamento nem impostos — a
    -- ressalva obrigatória de 5C.2 vive na tela e no catálogo.
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
  ),
  counts as (
    -- Uma passada só por orders para cancelados, válidos e valor cancelado.
    -- pending_cancel conta como cancelado (mesma semântica de order.cancelled
    -- em @sb/domain). valor_cancelado é o valor PEDIDO, não o estornado —
    -- a V3 não observa o estorno financeiro (5C.2).
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
    -- No grão SKU de L3, excluindo o bucket sku_id IS NULL (21,8% dos itens
    -- em 30 dias, medido em D-120) — contagem distinta calculada NO grão
    -- pedido, nunca somada de rollup inferior (D-017/D-050).
    select count(distinct m.sku_id) as skus_distintos_vendidos
    from public.daily_sku_metrics m
    where m.metric_date between p_date_from and p_date_to
      and m.sku_id is not null
      and m.units_sold > 0
      and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
  )
  select
    fees.taxas_ml,
    counts.pedidos_cancelados::bigint,
    -- Denominador = ELEGÍVEIS (válidos + cancelados), os dois lados da MESMA
    -- leitura de orders. NULL quando não há pedido nenhum — nunca 0 fingido.
    round(counts.pedidos_cancelados::numeric / nullif(counts.pedidos_cancelados + counts.pedidos_validos, 0), 4) as taxa_cancelamento,
    counts.valor_cancelado,
    skus.skus_distintos_vendidos::bigint
  from fees, counts, skus
$$;

comment on function public.get_sales_expanded_summary(date, date, uuid) is
  'Métricas 5C de vendas (D-157): taxas do ML, cancelamentos e SKUs distintos. security invoker: RLS de orders/order_items/daily_sku_metrics filtra antes da soma. Cancelamento vem de orders (L1) porque não existe em L3; a taxa usa os dois lados da mesma leitura.';

revoke all on function public.get_sales_expanded_summary(date, date, uuid) from public, anon;
grant execute on function public.get_sales_expanded_summary(date, date, uuid) to authenticated, service_role;

-- Catálogo canônico (espelho de docs/METRICS.md 5C.2) — o número só vai à
-- tela com a definição registrada e a ressalva visível ao lado (D-023).
insert into public.metric_definitions (
  id, name, formula, source, granularities, inclusions, exclusions,
  cancellation_treatment, timezone, definition_updated_on
)
values
  (
    'taxas_ml',
    'Taxas do Mercado Livre',
    'SUM(order_items.sale_fee) sobre vendas válidas',
    'order_items.sale_fee (100% preenchido, medido em D-120)',
    array['account', 'organization'],
    'Comissão de venda dos pedidos paid/partially_refunded, pela data civil de orders.date_created.',
    'Frete, taxa fixa por pedido, parcelamento, custo de cobrança do Mercado Pago e impostos retidos — lacunas da própria documentação oficial (5C.1).',
    'excluded',
    'America/Sao_Paulo',
    date '2026-08-31'
  ),
  (
    'pedidos_cancelados',
    'Pedidos cancelados',
    'COUNT(DISTINCT orders.id) where status in (cancelled, pending_cancel)',
    'orders.status e orders.date_created (L1 — cancelamento não existe no rollup L3)',
    array['account', 'organization'],
    'pending_cancel conta como cancelado, mesma semântica de order.cancelled em @sb/domain.',
    'Devolução, reembolso e mediação — três mecanismos independentes que NÃO são cancelamento (5C.3).',
    'included',
    'America/Sao_Paulo',
    date '2026-08-31'
  ),
  (
    'taxa_cancelamento',
    'Taxa de cancelamento',
    'pedidos_cancelados / NULLIF(pedidos_cancelados + pedidos_validos, 0)',
    'orders.status — os DOIS lados da mesma leitura de L1, nunca misturando cancelados de L1 com válidos de L3 (defasagem do recálculo entraria na razão)',
    array['account', 'organization'],
    'Denominador = elegíveis (válidos + cancelados), não só válidos.',
    'Devolução, reembolso e mediação (5C.3); pedidos em status intermediário (confirmed, payment_required etc.) não entram em nenhum lado.',
    'included',
    'America/Sao_Paulo',
    date '2026-08-31'
  ),
  (
    'valor_cancelado',
    'Valor cancelado',
    'SUM(orders.total_amount) dos cancelados',
    'orders.total_amount e orders.status',
    array['account', 'organization'],
    'Valor PEDIDO dos cancelados — o que deixou de ser vendido.',
    'O estorno financeiro real — a V3 não o observa; reembolso parcial permanece venda válida pelo total.',
    'included',
    'America/Sao_Paulo',
    date '2026-08-31'
  ),
  (
    'skus_distintos_vendidos',
    'SKUs distintos vendidos',
    'COUNT(DISTINCT sku_id) com units_sold > 0, calculado no grão pedido',
    'daily_sku_metrics no grão SKU',
    array['account', 'organization'],
    'SKUs vinculados com venda válida no período.',
    'O bucket sku_id IS NULL (itens vendidos sem vínculo — 21,8% dos itens em 30 dias, medido em D-120); contagem distinta nunca somada de rollup inferior (D-017/D-050).',
    'excluded',
    'America/Sao_Paulo',
    date '2026-08-31'
  );
