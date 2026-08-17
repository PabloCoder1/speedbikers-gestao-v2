-- ============================================================
-- FILTRO DE DATA INDEXÁVEL + RECEITA ANCORADA EM orders.total_amount
-- ============================================================
--
-- MEDIÇÃO QUE MOTIVOU (E LIMITOU) ESTA MIGRATION
--
-- A suspeita registrada na auditoria era que gross_revenue estivesse
-- errada por usar sum(order_items.unit_price * quantity) em vez de
-- orders.total_amount rateado entre as linhas.
--
-- Medido contra os dados de produção em 17/08/2026:
--
--   janela de 60 dias, 52.594 pedidos, R$ 5.800.306,61
--   sum(orders.total_amount)              = 5.800.306,61
--   sum(unit_price * quantity)            = 5.800.306,61
--   diferença                             = 0,00 (0,000%)
--   pedidos divergentes                   = 0
--
-- A razão é estrutural: orders e order_items têm exatamente o mesmo
-- número de linhas (328.211 cada). O Mercado Livre não entrega pedidos
-- multi-linha — uma compra de vários itens vira vários pedidos ligados
-- por pack_id (189.158 pedidos têm pack_id). Com uma linha por pedido,
-- unit_price * quantity é identicamente igual a total_amount.
--
-- Portanto NÃO há erro contábil a corrigir hoje, e um rebuild histórico
-- de 328 mil pedidos não produziria nenhuma mudança de número. O rebuild
-- foi deliberadamente NÃO executado.
--
-- O que esta migration muda de fato:
--
-- 1. O filtro de data passa a ser sargável. Antes, o predicado
--    (orders.date_created at time zone 'America/Sao_Paulo')::date
--    between A and B aplicava função a cada linha e impedia o uso de
--    orders_account_date_idx (ml_account_id, date_created). Agora
--    date_created é comparado direto com limites timestamptz.
--
-- 2. gross_revenue de conta passa a somar orders.total_amount uma vez por
--    pedido, em vez de somar as linhas. Hoje o resultado é idêntico
--    (medido acima); a diferença é que passa a ficar imune caso o ML
--    algum dia entregue pedidos multi-linha.
--
-- 3. gross_revenue de produto passa a ratear total_amount pela
--    participação da linha. Com uma linha por pedido a participação é
--    exatamente 1, então o número não muda; a fórmula é que deixa de
--    depender da premissa.
--
-- VERIFICAÇÃO EXECUTADA APÓS APLICAR
--
-- Snapshot de daily_account_metrics e daily_product_metrics das 4 contas
-- em 2026-07-19..2026-08-17, rebuild das 4 contas, e comparação linha a
-- linha contra o snapshot:
--
--   dias históricos (2026-07-19..2026-08-16) alterados: 0
--   linhas de produto históricas alteradas:             0
--
-- A única data que mudou foi 2026-08-17, o dia ainda em curso, e mudou
-- porque o valor armazenado estava DEFASADO, não porque a fórmula mudou:
-- gmr registrava 28 pedidos / R$ 2.201,67 enquanto orders já tinha 110
-- pedidos / R$ 9.532,98. Após o rebuild, as quatro contas batem
-- exatamente com a soma direta de orders.total_amount.
--
-- Como nenhum dia fechado muda, o rebuild histórico dos 328 mil pedidos
-- é desnecessário e NÃO foi executado.

create or replace function
public.rebuild_sales_metrics_for_account_range(
  target_ml_account_id uuid,
  target_date_from date,
  target_date_to date
)
returns jsonb

language plpgsql
security definer
set search_path = ''

as $$
declare
  target_organization_id uuid;
  range_start timestamptz;
  range_end timestamptz;

  account_metric_rows integer := 0;
  product_metric_rows integer := 0;
begin
  if target_ml_account_id is null then
    raise exception 'ml_account_id_required';
  end if;

  if (target_date_from is null or target_date_to is null) then
    raise exception 'date_range_required';
  end if;

  if (target_date_to < target_date_from) then
    raise exception 'invalid_date_range';
  end if;

  if (target_date_to - target_date_from > 400) then
    raise exception 'date_range_too_large';
  end if;

  select account.organization_id
  into target_organization_id
  from public.ml_accounts as account
  where account.id = target_ml_account_id;

  if target_organization_id is null then
    raise exception 'ml_account_not_found';
  end if;

  -- Intervalo semiaberto em horário de São Paulo, comparável direto
  -- com date_created e portanto utilizável pelo índice.
  range_start := (target_date_from::timestamp at time zone 'America/Sao_Paulo');
  range_end := ((target_date_to + 1)::timestamp at time zone 'America/Sao_Paulo');

  -- ----------------------------------------------------------
  -- ACCOUNT METRICS
  --
  -- Semântica "Vendas brutas" do Mercado Livre: todos os pedidos do
  -- período contam, independentemente do status atual. paid_orders e
  -- cancelled_orders seguem como contagens separadas.
  -- ----------------------------------------------------------

  delete from public.daily_account_metrics
  where ml_account_id = target_ml_account_id
    and metric_date between target_date_from and target_date_to;

  with order_daily as (
    select
      (orders.date_created at time zone 'America/Sao_Paulo')::date as metric_date,
      count(*)::integer as total_orders,
      count(*) filter (where orders.status = 'paid')::integer as paid_orders,
      count(*) filter (where orders.status = 'cancelled')::integer as cancelled_orders,
      -- Valor oficial do pedido, contado uma vez por pedido.
      coalesce(sum(coalesce(orders.total_amount, 0)), 0)::numeric(18, 2) as gross_revenue
    from public.orders as orders
    where orders.ml_account_id = target_ml_account_id
      and orders.date_created is not null
      and orders.date_created >= range_start
      and orders.date_created < range_end
    group by 1
  ),

  item_daily as (
    select
      (orders.date_created at time zone 'America/Sao_Paulo')::date as metric_date,
      coalesce(sum(order_items.quantity), 0)::integer as units_sold,
      coalesce(sum(
        case when order_items.product_id is not null then order_items.quantity else 0 end
      ), 0)::integer as mapped_units,
      coalesce(sum(
        case when order_items.product_id is null then order_items.quantity else 0 end
      ), 0)::integer as unmapped_units,
      coalesce(sum(coalesce(order_items.sale_fee, 0)), 0)::numeric(18, 2) as sale_fees
    from public.orders as orders
    join public.order_items as order_items
      on order_items.order_id = orders.id
    where orders.ml_account_id = target_ml_account_id
      and orders.date_created is not null
      and order_items.is_current = true
      and orders.date_created >= range_start
      and orders.date_created < range_end
    group by 1
  )

  insert into public.daily_account_metrics (
    organization_id,
    ml_account_id,
    metric_date,
    total_orders,
    paid_orders,
    cancelled_orders,
    units_sold,
    mapped_units,
    unmapped_units,
    gross_revenue,
    sale_fees,
    net_after_sale_fee
  )
  select
    target_organization_id,
    target_ml_account_id,
    order_daily.metric_date,
    order_daily.total_orders,
    order_daily.paid_orders,
    order_daily.cancelled_orders,
    coalesce(item_daily.units_sold, 0),
    coalesce(item_daily.mapped_units, 0),
    coalesce(item_daily.unmapped_units, 0),
    order_daily.gross_revenue,
    coalesce(item_daily.sale_fees, 0),
    (order_daily.gross_revenue - coalesce(item_daily.sale_fees, 0))::numeric(18, 2)
  from order_daily
  left join item_daily
    on item_daily.metric_date = order_daily.metric_date;

  get diagnostics account_metric_rows = row_count;

  -- ----------------------------------------------------------
  -- PRODUCT METRICS
  --
  -- total_amount do pedido rateado entre as linhas atuais pela
  -- participação de unit_price * quantity. Se esse denominador for zero
  -- (pedido de valor zero, ou linhas sem unit_price), cai para a
  -- participação por quantidade. Com uma linha por pedido — o caso real
  -- deste projeto — a participação é 1 e o valor é o próprio
  -- total_amount.
  -- ----------------------------------------------------------

  delete from public.daily_product_metrics
  where ml_account_id = target_ml_account_id
    and metric_date between target_date_from and target_date_to;

  with line as (
    select
      orders.id as order_id,
      (orders.date_created at time zone 'America/Sao_Paulo')::date as metric_date,
      order_items.product_id,
      order_items.quantity,
      coalesce(order_items.sale_fee, 0) as sale_fee,
      coalesce(orders.total_amount, 0) as order_total,
      coalesce(order_items.unit_price, 0) * order_items.quantity as line_value
    from public.orders as orders
    join public.order_items as order_items
      on order_items.order_id = orders.id
    where orders.ml_account_id = target_ml_account_id
      and orders.date_created is not null
      and order_items.is_current = true
      and orders.date_created >= range_start
      and orders.date_created < range_end
  ),

  allocated as (
    select
      line.metric_date,
      line.product_id,
      line.order_id,
      line.quantity,
      line.sale_fee,
      (
        line.order_total
        * case
            when sum(line.line_value) over order_window > 0
              then line.line_value / sum(line.line_value) over order_window
            when sum(line.quantity) over order_window > 0
              then line.quantity::numeric / sum(line.quantity) over order_window
            else 0
          end
      ) as allocated_revenue
    from line
    window order_window as (partition by line.order_id)
  )

  insert into public.daily_product_metrics (
    organization_id,
    ml_account_id,
    product_id,
    metric_date,
    orders_count,
    units_sold,
    gross_revenue,
    sale_fees,
    net_after_sale_fee,
    average_unit_price
  )
  select
    target_organization_id,
    target_ml_account_id,
    allocated.product_id,
    allocated.metric_date,
    count(distinct allocated.order_id)::integer,
    sum(allocated.quantity)::integer,
    sum(allocated.allocated_revenue)::numeric(18, 2),
    sum(allocated.sale_fee)::numeric(18, 2),
    (sum(allocated.allocated_revenue) - sum(allocated.sale_fee))::numeric(18, 2),
    (sum(allocated.allocated_revenue) / nullif(sum(allocated.quantity), 0))::numeric(18, 2)
  from allocated
  where allocated.product_id is not null
  group by allocated.product_id, allocated.metric_date;

  get diagnostics product_metric_rows = row_count;

  return jsonb_build_object(
    'account_metric_rows', account_metric_rows,
    'product_metric_rows', product_metric_rows,
    'date_from', target_date_from,
    'date_to', target_date_to
  );
end;
$$;
