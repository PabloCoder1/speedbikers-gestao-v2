-- ============================================================
-- Série diária de vendas — base do gráfico de tendência do Dashboard
-- Geral/por Conta (Fase 5A).
--
-- Mesmo raciocínio de get_sales_summary (20260821190000): soma
-- daily_account_metrics, que já é o rollup correto por conta, em vez de
-- duplicar cálculo. A diferença é o GROUP BY — aqui por dia, lá pelo
-- período inteiro. A mesma nota sobre segurança da soma entre contas
-- (packs não atravessam contas do Mercado Livre, D-017/D-050) vale aqui.
--
-- Dias sem nenhuma linha em daily_account_metrics simplesmente NÃO
-- aparecem no resultado — "nunca calculado" não vira zero fabricado. A
-- tela decide o que fazer com a lacuna (docs/HANDOFF.md, mesma distinção
-- já usada pelo Dashboard Geral).
-- ============================================================

create function public.get_sales_daily_series(
  p_date_from date,
  p_date_to date,
  p_ml_account_id uuid default null
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
  select
    m.metric_date,
    sum(m.units_sold)::bigint as units_sold,
    round(sum(m.gross_revenue), 2) as gross_revenue,
    sum(m.orders_count)::bigint as orders_count,
    sum(m.purchases_count)::bigint as purchases_count
  from public.daily_account_metrics m
  where m.metric_date between p_date_from and p_date_to
    and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
  group by m.metric_date
  order by m.metric_date
$$;

comment on function public.get_sales_daily_series(date, date, uuid) is
  'Série diária (grão organização, ou de uma conta se informada) para o gráfico de tendência. Dias sem linha em daily_account_metrics ficam ausentes, não zerados. security invoker: RLS de daily_account_metrics filtra antes do GROUP BY.';

revoke all on function public.get_sales_daily_series(date, date, uuid) from public, anon;
grant execute on function public.get_sales_daily_series(date, date, uuid) to authenticated, service_role;
