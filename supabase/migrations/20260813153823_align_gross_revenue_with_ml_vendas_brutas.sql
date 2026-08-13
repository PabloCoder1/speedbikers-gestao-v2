-- ============================================================
-- Speed Bikers Gestão V2
-- Alinha gross_revenue com "Vendas brutas" do Mercado Livre
--
-- O ML define Vendas brutas como o valor de TODAS as vendas do
-- período, "sem considerar custos, cancelamentos ou devoluções".
-- Cancelamentos são uma métrica separada, nunca subtraída.
--
-- A regra anterior (orders.status = 'paid') subcontava a receita
-- em ~5-7%: vendas canceladas depois de feitas sumiam do total.
--
-- Esta migration remove o filtro de status do cálculo de
-- receita/unidades, tanto nas métricas de conta quanto nas de
-- produto. paid_orders e cancelled_orders continuam existindo
-- como contagens separadas.
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
  --
  -- Receita/unidades seguem a semântica "Vendas brutas" do
  -- Mercado Livre: todos os pedidos do período contam,
  -- independentemente do status atual.
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
  --
  -- Mesma semântica de vendas brutas do bloco anterior.
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
