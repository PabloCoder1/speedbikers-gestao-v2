-- ============================================================
-- Recalculo atomico das metricas diarias (D-017/D-050/D-051).
--
-- O calculo continua em private.compute_daily_sales_metrics. Esta migration
-- adiciona somente a materializacao transacional: apaga o intervalo da conta
-- e reinsere os tres graos a partir do mesmo snapshot de L1.
--
-- A trava consultiva por conta serializa tanto incrementais quanto rebuilds.
-- Tasks de minutos/SKUs diferentes podem chegar juntas; sem a trava, dois
-- DELETE + INSERT concorrentes disputariam as constraints de grao.
-- ============================================================

create function private.refresh_daily_sales_metrics(
  p_organization_id uuid,
  p_ml_account_id uuid,
  p_date_from date,
  p_date_to date
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  v_affected integer := 0;
begin
  if p_organization_id is null
     or p_ml_account_id is null
     or p_date_from is null
     or p_date_to is null
     or p_date_from > p_date_to then
    raise exception 'invalid sales metrics refresh range'
      using errcode = '22023';
  end if;

  -- A mesma chave e usada pelo incremental e pelo rebuild: nunca existe um
  -- rebuild da conta correndo em paralelo com um refresh diario dela.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_ml_account_id::text, 0)
  );

  if not exists (
    select 1
    from public.ml_accounts a
    where a.id = p_ml_account_id
      and a.organization_id = p_organization_id
  ) then
    raise exception 'ml account does not belong to organization'
      using errcode = '22023';
  end if;

  delete from public.daily_listing_metrics
  where organization_id = p_organization_id
    and ml_account_id = p_ml_account_id
    and metric_date between p_date_from and p_date_to;

  delete from public.daily_sku_metrics
  where organization_id = p_organization_id
    and ml_account_id = p_ml_account_id
    and metric_date between p_date_from and p_date_to;

  delete from public.daily_account_metrics
  where organization_id = p_organization_id
    and ml_account_id = p_ml_account_id
    and metric_date between p_date_from and p_date_to;

  -- Uma unica instrucao e um CTE MATERIALIZED: os tres INSERTs enxergam o
  -- mesmo snapshot de orders/order_items, mesmo se a sincronizacao estiver
  -- persistindo outro pedido em paralelo.
  with computed as materialized (
    select *
    from private.compute_daily_sales_metrics(
      p_organization_id,
      p_date_from,
      p_date_to,
      p_ml_account_id
    )
  ),
  inserted_listing as (
    insert into public.daily_listing_metrics (
      organization_id,
      ml_account_id,
      mlb_id,
      variation_id,
      metric_date,
      units_sold,
      gross_revenue,
      orders_count,
      purchases_count
    )
    select
      metrics.organization_id,
      metrics.ml_account_id,
      metrics.mlb_id,
      metrics.variation_id,
      metrics.metric_date,
      metrics.units_sold,
      metrics.gross_revenue,
      metrics.orders_count,
      metrics.purchases_count
    from computed metrics
    where metrics.metric_grain = 'listing'
    returning 1
  ),
  inserted_sku as (
    insert into public.daily_sku_metrics (
      organization_id,
      ml_account_id,
      sku_id,
      metric_date,
      units_sold,
      gross_revenue,
      orders_count,
      purchases_count
    )
    select
      metrics.organization_id,
      metrics.ml_account_id,
      metrics.sku_id,
      metrics.metric_date,
      metrics.units_sold,
      metrics.gross_revenue,
      metrics.orders_count,
      metrics.purchases_count
    from computed metrics
    where metrics.metric_grain = 'sku'
    returning 1
  ),
  inserted_account as (
    insert into public.daily_account_metrics (
      organization_id,
      ml_account_id,
      metric_date,
      units_sold,
      gross_revenue,
      orders_count,
      purchases_count
    )
    select
      metrics.organization_id,
      metrics.ml_account_id,
      metrics.metric_date,
      metrics.units_sold,
      metrics.gross_revenue,
      metrics.orders_count,
      metrics.purchases_count
    from computed metrics
    where metrics.metric_grain = 'account'
    returning 1
  )
  select
    (select count(*) from inserted_listing)
    + (select count(*) from inserted_sku)
    + (select count(*) from inserted_account)
  into v_affected;

  return v_affected;
end;
$function$;

comment on function private.refresh_daily_sales_metrics(uuid, uuid, date, date) is
  'Substitui atomicamente os tres graos L3 de uma conta no intervalo informado.';

revoke all on function private.refresh_daily_sales_metrics(uuid, uuid, date, date)
  from public, anon, authenticated, service_role;
grant execute on function private.refresh_daily_sales_metrics(uuid, uuid, date, date)
  to service_role;

-- RPC estreita usada pelo job incremental. Um dia de negocio por chamada.
create function public.recompute_daily_sales_metrics(
  p_organization_id uuid,
  p_ml_account_id uuid,
  p_metric_date date
)
returns integer
language sql
volatile
security invoker
set search_path = ''
as $function$
  select private.refresh_daily_sales_metrics(
    p_organization_id,
    p_ml_account_id,
    p_metric_date,
    p_metric_date
  );
$function$;

comment on function public.recompute_daily_sales_metrics(uuid, uuid, date) is
  'Recalculo incremental idempotente de uma conta em um dia de negocio.';

-- RPC explicita de rebuild. Disponivel e testada, mas nao chamada no Dev ate
-- os quatro backfills de pedidos cobrirem os 12 meses (docs/HANDOFF.md).
create function public.rebuild_daily_sales_metrics(
  p_organization_id uuid,
  p_ml_account_id uuid,
  p_date_from date,
  p_date_to date
)
returns integer
language sql
volatile
security invoker
set search_path = ''
as $function$
  select private.refresh_daily_sales_metrics(
    p_organization_id,
    p_ml_account_id,
    p_date_from,
    p_date_to
  );
$function$;

comment on function public.rebuild_daily_sales_metrics(uuid, uuid, date, date) is
  'Rebuild idempotente das tres projecoes L3 de uma conta em um intervalo inclusivo.';

revoke all on function public.recompute_daily_sales_metrics(uuid, uuid, date)
  from public, anon, authenticated, service_role;
revoke all on function public.rebuild_daily_sales_metrics(uuid, uuid, date, date)
  from public, anon, authenticated, service_role;

grant execute on function public.recompute_daily_sales_metrics(uuid, uuid, date)
  to service_role;
grant execute on function public.rebuild_daily_sales_metrics(uuid, uuid, date, date)
  to service_role;
