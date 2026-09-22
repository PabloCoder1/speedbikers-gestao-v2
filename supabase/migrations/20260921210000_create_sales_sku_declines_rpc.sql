-- Produtos que caíram entre duas janelas equivalentes, para o Copiloto.
-- A comparação é agregada no SQL e limitada depois da ordenação. Security
-- invoker preserva a RLS de daily_sku_metrics por conta.
create function public.get_sales_sku_declines(
  p_date_from date,
  p_date_to date,
  p_previous_date_from date,
  p_previous_date_to date,
  p_ml_account_id uuid default null,
  p_order_by text default 'units',
  p_limit integer default 10
)
returns table (
  sku_id uuid, sku text, title text,
  previous_units_sold bigint, current_units_sold bigint, units_delta bigint, units_change_pct numeric,
  previous_gross_revenue numeric, current_gross_revenue numeric, gross_revenue_delta numeric, orders_delta bigint
)
language sql stable security invoker set search_path = ''
as $$
  with previous_period as (
    select m.sku_id, sum(m.units_sold)::bigint as units_sold,
           round(sum(m.gross_revenue), 2) as gross_revenue, sum(m.orders_count)::bigint as orders_count
      from public.daily_sku_metrics m
     where m.sku_id is not null
       and m.metric_date between p_previous_date_from and p_previous_date_to
       and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
     group by m.sku_id
  ), current_period as (
    select m.sku_id, sum(m.units_sold)::bigint as units_sold,
           round(sum(m.gross_revenue), 2) as gross_revenue, sum(m.orders_count)::bigint as orders_count
      from public.daily_sku_metrics m
     where m.sku_id is not null
       and m.metric_date between p_date_from and p_date_to
       and (p_ml_account_id is null or m.ml_account_id = p_ml_account_id)
     group by m.sku_id
  ), changes as (
    select p.sku_id, s.sku, s.title,
           p.units_sold as previous_units_sold, coalesce(c.units_sold, 0)::bigint as current_units_sold,
           (coalesce(c.units_sold, 0) - p.units_sold)::bigint as units_delta,
           round((coalesce(c.units_sold, 0) - p.units_sold)::numeric / nullif(p.units_sold, 0), 4) as units_change_pct,
           p.gross_revenue as previous_gross_revenue, coalesce(c.gross_revenue, 0) as current_gross_revenue,
           round(coalesce(c.gross_revenue, 0) - p.gross_revenue, 2) as gross_revenue_delta,
           (coalesce(c.orders_count, 0) - p.orders_count)::bigint as orders_delta
      from previous_period p
      left join current_period c on c.sku_id = p.sku_id
      join public.skus s on s.id = p.sku_id
  )
  select * from changes
   where case p_order_by when 'revenue' then gross_revenue_delta < 0 else units_delta < 0 end
   order by case when p_order_by = 'revenue' then gross_revenue_delta else units_delta end asc, sku asc
   limit least(greatest(p_limit, 1), 50)
$$;

comment on function public.get_sales_sku_declines(date, date, date, date, uuid, text, integer) is
  'SKUs cuja venda caiu entre duas janelas explícitas, agregada em SQL e limitada após a ordenação. p_order_by = units | revenue; security invoker respeita a RLS de daily_sku_metrics.';

revoke all on function public.get_sales_sku_declines(date, date, date, date, uuid, text, integer) from public, anon;
grant execute on function public.get_sales_sku_declines(date, date, date, date, uuid, text, integer) to authenticated, service_role;
