-- ============================================================
-- RANKING DE PRODUTOS COM MÉTRICA CONFIGURÁVEL E CURVA ABC
-- ============================================================
--
-- Aplicada em produção como 20260818122049.
--
-- Hoje o Top produtos usa get_dashboard_top_products, fixo em
-- gross_revenue desc, e não existe classificação ABC em lugar nenhum.
--
-- Esta função resolve as duas coisas numa passada: classifica TODOS os
-- produtos do período pela métrica escolhida (participação acumulada) e
-- devolve o topo já com a classe de cada um.
--
-- Corte ABC: A até 80% do acumulado, B até 95%, C o restante. Produtos
-- sem valor na métrica ficam fora da curva — não são "C", simplesmente
-- não venderam no período.
--
-- A métrica importa, e é por isso que é parâmetro e não constante.
-- Medido em produção nos últimos 30 dias: por faturamento o top 3 é
-- BAULATPTO.SUP99 / BAU06 / BAU98 (ticket alto); por unidades é
-- 13014 / EB0001 / 20017. Produtos completamente diferentes.
--
-- Medido: ~85 ms de mediana para 90 dias, nas três métricas.

create or replace function public.get_dashboard_product_ranking(
  target_organization_id uuid,
  target_date_from date,
  target_date_to date,
  target_metric text default 'revenue',
  target_ml_account_id uuid default null,
  target_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  safe_limit integer := least(greatest(coalesce(target_limit, 10), 1), 100);
  result jsonb;
begin
  if not private.is_organization_member(target_organization_id) then
    raise exception 'not_authorized';
  end if;

  if target_metric not in ('revenue', 'units', 'orders') then
    raise exception 'invalid_ranking_metric';
  end if;

  if target_date_from is null or target_date_to is null
     or target_date_to < target_date_from then
    raise exception 'invalid_date_range';
  end if;

  if target_ml_account_id is not null
     and not private.can_access_ml_account(target_ml_account_id) then
    raise exception 'not_authorized';
  end if;

  with totals as materialized (
    select
      metric.product_id,
      sum(metric.units_sold)::bigint as units_sold,
      sum(metric.orders_count)::bigint as orders_count,
      sum(metric.gross_revenue)::numeric as gross_revenue,
      sum(metric.sale_fees)::numeric as sale_fees,
      sum(metric.net_after_sale_fee)::numeric as net_after_sale_fee
    from public.daily_product_metrics as metric
    join public.ml_accounts as account
      on account.id = metric.ml_account_id
     and account.organization_id = target_organization_id
    where metric.organization_id = target_organization_id
      and metric.metric_date between target_date_from and target_date_to
      and private.can_access_ml_account(account.id)
      and (target_ml_account_id is null or metric.ml_account_id = target_ml_account_id)
    group by metric.product_id
  ),
  valued as materialized (
    select
      totals.*,
      case target_metric
        when 'units' then totals.units_sold::numeric
        when 'orders' then totals.orders_count::numeric
        else totals.gross_revenue
      end as metric_value
    from totals
    where case target_metric
            when 'units' then totals.units_sold::numeric
            when 'orders' then totals.orders_count::numeric
            else totals.gross_revenue
          end > 0
  ),
  classified as materialized (
    select
      valued.*,
      sum(valued.metric_value) over () as metric_total,
      sum(valued.metric_value) over (
        order by valued.metric_value desc, valued.product_id
        rows between unbounded preceding and current row
      ) as running_value,
      row_number() over (order by valued.metric_value desc, valued.product_id) as position
    from valued
  ),
  with_class as materialized (
    select
      classified.*,
      case
        when classified.metric_total <= 0 then 'C'
        when classified.running_value / classified.metric_total <= 0.80 then 'A'
        when classified.running_value / classified.metric_total <= 0.95 then 'B'
        else 'C'
      end as abc_class
    from classified
  )
  select jsonb_build_object(
    'metric', target_metric,
    'dateFrom', target_date_from,
    'dateTo', target_date_to,
    'metricTotal', coalesce((select max(metric_total) from with_class), 0),
    'rankedProducts', (select count(*) from with_class),
    'abc', coalesce((
      select jsonb_agg(row_to_json(curve) order by curve.abc_class)
      from (
        select
          with_class.abc_class,
          count(*)::bigint as products,
          sum(with_class.metric_value)::numeric as metric_value,
          sum(with_class.units_sold)::bigint as units_sold,
          sum(with_class.gross_revenue)::numeric as gross_revenue,
          round(
            100.0 * sum(with_class.metric_value)
            / nullif(max(with_class.metric_total), 0), 1
          ) as metric_share
        from with_class
        group by with_class.abc_class
      ) as curve
    ), '[]'::jsonb),
    'top', coalesce((
      select jsonb_agg(row_to_json(item) order by item.position)
      from (
        select
          with_class.position,
          with_class.product_id,
          product.sku,
          product.name as product_name,
          with_class.abc_class,
          with_class.units_sold,
          with_class.orders_count,
          with_class.gross_revenue,
          with_class.sale_fees,
          with_class.net_after_sale_fee,
          with_class.metric_value,
          round(
            100.0 * with_class.metric_value / nullif(with_class.metric_total, 0), 2
          ) as metric_share,
          round(
            100.0 * with_class.running_value / nullif(with_class.metric_total, 0), 2
          ) as cumulative_share,
          (with_class.gross_revenue / nullif(with_class.units_sold, 0))::numeric(18,2)
            as average_unit_price
        from with_class
        join public.products as product
          on product.id = with_class.product_id
         and product.organization_id = target_organization_id
        order by with_class.position
        limit safe_limit
      ) as item
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_dashboard_product_ranking(uuid, date, date, text, uuid, integer)
from public, anon;

grant execute on function public.get_dashboard_product_ranking(uuid, date, date, text, uuid, integer)
to authenticated;
