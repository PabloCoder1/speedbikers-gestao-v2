-- ============================================================
-- Visão "hoje" do Dashboard de Vendas (D-158) — o sub-item do item de
-- Vendas que 5C.4 deixou com decisão de desenho própria, agora tomada:
-- LÊ `orders` DIRETO (L1) E SINALIZA a incompletude, nunca finge que o
-- dia fechou. O precedente é D-157: cancelamento também sai do L1 com a
-- fonte declarada na tela.
--
-- Por que não o rollup L3: `daily_*_metrics` do dia corrente está
-- incompleto POR CONSTRUÇÃO (a chave suja materializa com atraso de
-- minutos e o dia só fecha à meia-noite SP) — o projeto evita lê-lo em
-- todos os outros lugares. As fórmulas são as MESMAS canônicas de
-- `metric_definitions` (receita_bruta, unidades_vendidas, pedidos,
-- pedidos_por_pack), avaliadas ao vivo sobre a fonte que o catálogo já
-- cita (`orders`/`order_items`) — nenhuma métrica nova nasce aqui.
--
-- `last_order_at` é o sinal de honestidade da tela: "última venda às
-- HH:MM" diz até onde o dia foi observado (o webhook traz pedidos em
-- segundos desde D-101).
--
-- EXPLAIN medido (dia com 136 pedidos válidos): 19 ms / 2.9k buffers,
-- tudo por orders_date_created_idx — nenhum índice novo.
-- ============================================================

create function public.get_sales_today_summary(
  p_date date,
  p_ml_account_id uuid default null
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
  units as (
    select coalesce(sum(oi.quantity), 0)::bigint as units_sold
    from public.order_items oi
    join valid_orders v on oi.order_id = v.id
  ),
  totals as (
    -- Receita/pedidos/compras contados nas ORDERS, não no join com itens —
    -- imune a pedido com mais de um item duplicar total_amount.
    select
      coalesce(round(sum(v.total_amount), 2), 0) as gross_revenue,
      count(distinct v.id)::bigint as orders_count,
      count(distinct case when v.pack_id is null then 'order:' || v.id::text else 'pack:' || v.pack_id::text end)::bigint as purchases_count,
      max(v.date_created) as last_order_at
    from valid_orders v
  )
  select units.units_sold, totals.gross_revenue, totals.orders_count, totals.purchases_count, totals.last_order_at
  from units, totals
$$;

comment on function public.get_sales_today_summary(date, uuid) is
  'Visão "hoje" de /vendas (D-158): as fórmulas canônicas de venda avaliadas ao vivo sobre orders (L1) para um único dia civil SP — o rollup L3 do dia corrente é incompleto por construção. security invoker: RLS filtra antes da soma. last_order_at diz até onde o dia foi observado.';

revoke all on function public.get_sales_today_summary(date, uuid) from public, anon;
grant execute on function public.get_sales_today_summary(date, uuid) to authenticated, service_role;
