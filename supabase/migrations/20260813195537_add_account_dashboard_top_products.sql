-- ============================================================
-- Speed Bikers Gestão V2
-- Dashboard: Top produtos por conta Mercado Livre
-- ============================================================

create or replace function
public.get_dashboard_top_products_for_account(
  target_organization_id uuid,
  target_ml_account_id uuid,
  target_date_from date,
  target_date_to date,
  target_limit integer default 10
)
returns table (
  product_id uuid,
  sku text,
  product_name text,
  orders_count bigint,
  units_sold bigint,
  gross_revenue numeric,
  sale_fees numeric,
  net_after_sale_fee numeric,
  average_unit_price numeric
)
language sql
security invoker
set search_path = ''
stable

as $$

select
  product.id
    as product_id,

  product.sku,

  product.name
    as product_name,

  sum(
    metric.orders_count
  )::bigint
    as orders_count,

  sum(
    metric.units_sold
  )::bigint
    as units_sold,

  sum(
    metric.gross_revenue
  )::numeric(18, 2)
    as gross_revenue,

  sum(
    metric.sale_fees
  )::numeric(18, 2)
    as sale_fees,

  sum(
    metric.net_after_sale_fee
  )::numeric(18, 2)
    as net_after_sale_fee,

  (
    sum(
      metric.gross_revenue
    )
    /
    nullif(
      sum(
        metric.units_sold
      ),
      0
    )
  )::numeric(18, 2)
    as average_unit_price

from public.daily_product_metrics
  as metric

join public.products
  as product

  on product.id =
     metric.product_id

where
  metric.organization_id =
    target_organization_id

  and metric.ml_account_id =
    target_ml_account_id

  and product.organization_id =
    target_organization_id

  and private.can_access_ml_account(
    target_ml_account_id
  )

  and metric.metric_date
    between
      target_date_from
      and target_date_to

group by
  product.id,
  product.sku,
  product.name

order by
  gross_revenue desc,
  units_sold desc

limit greatest(
  least(
    target_limit,
    100
  ),
  1
);

$$;


revoke all
on function
public.get_dashboard_top_products_for_account(
  uuid,
  uuid,
  date,
  date,
  integer
)
from public;


revoke all
on function
public.get_dashboard_top_products_for_account(
  uuid,
  uuid,
  date,
  date,
  integer
)
from anon;


grant execute
on function
public.get_dashboard_top_products_for_account(
  uuid,
  uuid,
  date,
  date,
  integer
)
to authenticated;