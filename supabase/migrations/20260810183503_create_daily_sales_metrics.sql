-- ============================================================
-- Speed Bikers Gestão V2
-- Daily analytical sales metrics
-- ============================================================


-- ============================================================
-- 1. DAILY ACCOUNT METRICS
-- ============================================================

create table public.daily_account_metrics (
  id uuid primary key
    default gen_random_uuid(),

  organization_id uuid not null,

  ml_account_id uuid not null,

  metric_date date not null,

  total_orders integer not null
    default 0
    check (
      total_orders >= 0
    ),

  paid_orders integer not null
    default 0
    check (
      paid_orders >= 0
    ),

  cancelled_orders integer not null
    default 0
    check (
      cancelled_orders >= 0
    ),

  units_sold integer not null
    default 0
    check (
      units_sold >= 0
    ),

  mapped_units integer not null
    default 0
    check (
      mapped_units >= 0
    ),

  unmapped_units integer not null
    default 0
    check (
      unmapped_units >= 0
    ),

  gross_revenue numeric(18, 2)
    not null default 0,

  sale_fees numeric(18, 2)
    not null default 0,

  net_after_sale_fee numeric(18, 2)
    not null default 0,

  created_at timestamptz not null
    default now(),

  updated_at timestamptz not null
    default now(),

  constraint daily_account_metrics_account_fk
    foreign key (
      organization_id,
      ml_account_id
    )
    references public.ml_accounts (
      organization_id,
      id
    )
    on delete cascade,

  constraint daily_account_metrics_unique
    unique (
      ml_account_id,
      metric_date
    )
);


create index daily_account_metrics_date_idx
on public.daily_account_metrics (
  ml_account_id,
  metric_date desc
);


create trigger daily_account_metrics_set_updated_at
before update
on public.daily_account_metrics
for each row
execute function private.set_updated_at();


-- ============================================================
-- 2. DAILY PRODUCT METRICS
-- ============================================================

create table public.daily_product_metrics (
  id uuid primary key
    default gen_random_uuid(),

  organization_id uuid not null,

  ml_account_id uuid not null,

  product_id uuid not null,

  metric_date date not null,

  orders_count integer not null
    default 0
    check (
      orders_count >= 0
    ),

  units_sold integer not null
    default 0
    check (
      units_sold >= 0
    ),

  gross_revenue numeric(18, 2)
    not null default 0,

  sale_fees numeric(18, 2)
    not null default 0,

  net_after_sale_fee numeric(18, 2)
    not null default 0,

  average_unit_price numeric(18, 2)
    not null default 0,

  created_at timestamptz not null
    default now(),

  updated_at timestamptz not null
    default now(),

  constraint daily_product_metrics_account_fk
    foreign key (
      organization_id,
      ml_account_id
    )
    references public.ml_accounts (
      organization_id,
      id
    )
    on delete cascade,

  constraint daily_product_metrics_product_fk
    foreign key (
      organization_id,
      product_id
    )
    references public.products (
      organization_id,
      id
    )
    on delete cascade,

  constraint daily_product_metrics_unique
    unique (
      ml_account_id,
      product_id,
      metric_date
    )
);


create index daily_product_metrics_account_date_idx
on public.daily_product_metrics (
  ml_account_id,
  metric_date desc
);


create index daily_product_metrics_product_date_idx
on public.daily_product_metrics (
  product_id,
  metric_date desc
);


create trigger daily_product_metrics_set_updated_at
before update
on public.daily_product_metrics
for each row
execute function private.set_updated_at();


-- ============================================================
-- 3. RLS
-- ============================================================

alter table public.daily_account_metrics
enable row level security;


alter table public.daily_product_metrics
enable row level security;


revoke all
on public.daily_account_metrics
from anon;


revoke all
on public.daily_product_metrics
from anon;


revoke all
on public.daily_account_metrics
from authenticated;


revoke all
on public.daily_product_metrics
from authenticated;


grant select
on public.daily_account_metrics
to authenticated;


grant select
on public.daily_product_metrics
to authenticated;


create policy
"users can view permitted daily account metrics"

on public.daily_account_metrics

for select
to authenticated

using (
  private.can_access_ml_account(
    ml_account_id
  )
);


create policy
"users can view permitted daily product metrics"

on public.daily_product_metrics

for select
to authenticated

using (
  private.can_access_ml_account(
    ml_account_id
  )
);


-- ============================================================
-- 4. REBUILD METRICS FOR DATE RANGE
--
-- This is intentionally deterministic.
-- We do not increment counters.
--
-- We delete + recalculate the affected dates from the
-- normalized order data, so retries and status changes are safe.
-- ============================================================

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

  account_metric_rows integer
    := 0;

  product_metric_rows integer
    := 0;
begin

  if target_ml_account_id is null then
    raise exception
      'ml_account_id_required';
  end if;


  if (
    target_date_from is null
    or
    target_date_to is null
  ) then
    raise exception
      'date_range_required';
  end if;


  if (
    target_date_to <
    target_date_from
  ) then
    raise exception
      'invalid_date_range';
  end if;


  if (
    target_date_to -
    target_date_from >
    400
  ) then
    raise exception
      'date_range_too_large';
  end if;


  select
    account.organization_id

  into
    target_organization_id

  from public.ml_accounts
    as account

  where account.id =
    target_ml_account_id;


  if target_organization_id is null then
    raise exception
      'ml_account_not_found';
  end if;


  -- ----------------------------------------------------------
  -- ACCOUNT METRICS
  -- ----------------------------------------------------------

  delete from
    public.daily_account_metrics

  where ml_account_id =
      target_ml_account_id

    and metric_date between
      target_date_from
      and target_date_to;


  with order_daily as (
    select
      (
        orders.date_created
        at time zone
          'America/Sao_Paulo'
      )::date
        as metric_date,

      count(*)::integer
        as total_orders,

      count(*)
        filter (
          where orders.status =
            'paid'
        )::integer
        as paid_orders,

      count(*)
        filter (
          where orders.status =
            'cancelled'
        )::integer
        as cancelled_orders

    from public.orders
      as orders

    where orders.ml_account_id =
        target_ml_account_id

      and orders.date_created
        is not null

      and (
        orders.date_created
        at time zone
          'America/Sao_Paulo'
      )::date
        between
          target_date_from
          and target_date_to

    group by 1
  ),

  item_daily as (
    select
      (
        orders.date_created
        at time zone
          'America/Sao_Paulo'
      )::date
        as metric_date,

      coalesce(
        sum(
          order_items.quantity
        ),
        0
      )::integer
        as units_sold,

      coalesce(
        sum(
          case
            when order_items.product_id
              is not null

            then order_items.quantity

            else 0
          end
        ),
        0
      )::integer
        as mapped_units,

      coalesce(
        sum(
          case
            when order_items.product_id
              is null

            then order_items.quantity

            else 0
          end
        ),
        0
      )::integer
        as unmapped_units,

      coalesce(
        sum(
          coalesce(
            order_items.unit_price,
            0
          )
          *
          order_items.quantity
        ),
        0
      )::numeric(18, 2)
        as gross_revenue,

      coalesce(
        sum(
          coalesce(
            order_items.sale_fee,
            0
          )
        ),
        0
      )::numeric(18, 2)
        as sale_fees

    from public.orders
      as orders

    join public.order_items
      as order_items

      on order_items.order_id =
        orders.id

    where orders.ml_account_id =
        target_ml_account_id

      and orders.status =
        'paid'

      and orders.date_created
        is not null

      and order_items.is_current =
        true

      and (
        orders.date_created
        at time zone
          'America/Sao_Paulo'
      )::date
        between
          target_date_from
          and target_date_to

    group by 1
  )

  insert into
    public.daily_account_metrics (
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

    coalesce(
      item_daily.units_sold,
      0
    ),

    coalesce(
      item_daily.mapped_units,
      0
    ),

    coalesce(
      item_daily.unmapped_units,
      0
    ),

    coalesce(
      item_daily.gross_revenue,
      0
    ),

    coalesce(
      item_daily.sale_fees,
      0
    ),

    (
      coalesce(
        item_daily.gross_revenue,
        0
      )
      -
      coalesce(
        item_daily.sale_fees,
        0
      )
    )::numeric(18, 2)

  from order_daily

  left join item_daily
    on item_daily.metric_date =
      order_daily.metric_date;


  get diagnostics
    account_metric_rows =
      row_count;


  -- ----------------------------------------------------------
  -- PRODUCT METRICS
  -- ----------------------------------------------------------

  delete from
    public.daily_product_metrics

  where ml_account_id =
      target_ml_account_id

    and metric_date between
      target_date_from
      and target_date_to;


  insert into
    public.daily_product_metrics (
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

    order_items.product_id,

    (
      orders.date_created
      at time zone
        'America/Sao_Paulo'
    )::date
      as metric_date,

    count(
      distinct orders.id
    )::integer
      as orders_count,

    sum(
      order_items.quantity
    )::integer
      as units_sold,

    sum(
      coalesce(
        order_items.unit_price,
        0
      )
      *
      order_items.quantity
    )::numeric(18, 2)
      as gross_revenue,

    sum(
      coalesce(
        order_items.sale_fee,
        0
      )
    )::numeric(18, 2)
      as sale_fees,

    (
      sum(
        coalesce(
          order_items.unit_price,
          0
        )
        *
        order_items.quantity
      )
      -
      sum(
        coalesce(
          order_items.sale_fee,
          0
        )
      )
    )::numeric(18, 2)
      as net_after_sale_fee,

    (
      sum(
        coalesce(
          order_items.unit_price,
          0
        )
        *
        order_items.quantity
      )
      /
      nullif(
        sum(
          order_items.quantity
        ),
        0
      )
    )::numeric(18, 2)
      as average_unit_price

  from public.orders
    as orders

  join public.order_items
    as order_items

    on order_items.order_id =
      orders.id

  where orders.ml_account_id =
      target_ml_account_id

    and orders.status =
      'paid'

    and orders.date_created
      is not null

    and order_items.is_current =
      true

    and order_items.product_id
      is not null

    and (
      orders.date_created
      at time zone
        'America/Sao_Paulo'
    )::date
      between
        target_date_from
        and target_date_to

  group by
    order_items.product_id,

    (
      orders.date_created
      at time zone
        'America/Sao_Paulo'
    )::date;


  get diagnostics
    product_metric_rows =
      row_count;


  return jsonb_build_object(
    'account_metric_rows',
      account_metric_rows,

    'product_metric_rows',
      product_metric_rows,

    'date_from',
      target_date_from,

    'date_to',
      target_date_to
  );
end;
$$;


-- ============================================================
-- 5. SECURITY
-- ============================================================

revoke all
on function
public.rebuild_sales_metrics_for_account_range(
  uuid,
  date,
  date
)
from public;


revoke all
on function
public.rebuild_sales_metrics_for_account_range(
  uuid,
  date,
  date
)
from anon;


revoke all
on function
public.rebuild_sales_metrics_for_account_range(
  uuid,
  date,
  date
)
from authenticated;


grant execute
on function
public.rebuild_sales_metrics_for_account_range(
  uuid,
  date,
  date
)
to service_role;