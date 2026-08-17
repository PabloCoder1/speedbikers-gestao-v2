-- AUDITORIA: PROPOSTAS NÃO APLICADAS
--
-- Este arquivo é deliberadamente separado de supabase/migrations. Ele não foi
-- executado local ou remotamente. Antes de promover qualquer bloco para uma
-- migration versionada: revisar a regra de negócio, testar em clone/staging,
-- executar EXPLAIN (ANALYZE, BUFFERS) e planejar o rebuild do período histórico.

-- ============================================================================
-- 1. Corrigir a fonte de gross_revenue e tornar o filtro de data indexável
-- ============================================================================
--
-- Problema auditado:
-- 20260813153823_align_gross_revenue_with_ml_vendas_brutas.sql soma
-- order_items.unit_price * quantity. O valor oficial do pedido está em
-- orders.total_amount. Para métricas de produto, o total do pedido precisa ser
-- rateado entre todas as linhas atuais. O rateio primário abaixo usa a
-- participação do valor de lista da linha; se esse total for zero, usa a
-- participação das quantidades. Linhas sem product_id participam do denominador,
-- mas não são atribuídas a um produto, evitando inflar os produtos mapeados.
--
-- O filtro também deixa de converter date_created linha a linha e passa a usar
-- limites timestamptz de dias civis em America/Sao_Paulo. Assim o índice atual
-- de orders (ml_account_id, date_created) pode ser usado.

create or replace function public.rebuild_sales_metrics_for_account_range(
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

  if target_date_from is null or target_date_to is null then
    raise exception 'date_range_required';
  end if;

  if target_date_to < target_date_from then
    raise exception 'invalid_date_range';
  end if;

  if target_date_to - target_date_from > 400 then
    raise exception 'date_range_too_large';
  end if;

  select account.organization_id
  into target_organization_id
  from public.ml_accounts as account
  where account.id = target_ml_account_id;

  if target_organization_id is null then
    raise exception 'ml_account_not_found';
  end if;

  range_start := target_date_from::timestamp at time zone 'America/Sao_Paulo';
  range_end := (target_date_to + 1)::timestamp at time zone 'America/Sao_Paulo';

  delete from public.daily_account_metrics
  where ml_account_id = target_ml_account_id
    and metric_date between target_date_from and target_date_to;

  with selected_orders as (
    select
      order_row.id,
      order_row.status,
      coalesce(order_row.total_amount, 0)::numeric as total_amount,
      (order_row.date_created at time zone 'America/Sao_Paulo')::date as metric_date
    from public.orders as order_row
    where order_row.ml_account_id = target_ml_account_id
      and order_row.date_created >= range_start
      and order_row.date_created < range_end
  ),
  item_by_order as (
    select
      item.order_id,
      coalesce(sum(item.quantity), 0)::integer as units_sold,
      coalesce(sum(item.quantity) filter (where item.product_id is not null), 0)::integer
        as mapped_units,
      coalesce(sum(item.quantity) filter (where item.product_id is null), 0)::integer
        as unmapped_units,
      coalesce(sum(item.sale_fee), 0)::numeric as sale_fees
    from public.order_items as item
    join selected_orders as selected on selected.id = item.order_id
    where item.is_current = true
    group by item.order_id
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
    selected.metric_date,
    count(*)::integer,
    count(*) filter (where selected.status = 'paid')::integer,
    count(*) filter (where selected.status = 'cancelled')::integer,
    coalesce(sum(items.units_sold), 0)::integer,
    coalesce(sum(items.mapped_units), 0)::integer,
    coalesce(sum(items.unmapped_units), 0)::integer,
    coalesce(sum(selected.total_amount), 0)::numeric(18, 2),
    coalesce(sum(items.sale_fees), 0)::numeric(18, 2),
    (
      coalesce(sum(selected.total_amount), 0)
      - coalesce(sum(items.sale_fees), 0)
    )::numeric(18, 2)
  from selected_orders as selected
  left join item_by_order as items on items.order_id = selected.id
  group by selected.metric_date;

  get diagnostics account_metric_rows = row_count;

  delete from public.daily_product_metrics
  where ml_account_id = target_ml_account_id
    and metric_date between target_date_from and target_date_to;

  with selected_orders as (
    select
      order_row.id,
      coalesce(order_row.total_amount, 0)::numeric as total_amount,
      (order_row.date_created at time zone 'America/Sao_Paulo')::date as metric_date
    from public.orders as order_row
    where order_row.ml_account_id = target_ml_account_id
      and order_row.date_created >= range_start
      and order_row.date_created < range_end
  ),
  current_items as (
    select
      selected.id as order_id,
      selected.metric_date,
      selected.total_amount,
      item.product_id,
      item.quantity,
      coalesce(item.unit_price, 0) * item.quantity as line_list_gross,
      coalesce(item.sale_fee, 0)::numeric as sale_fee,
      sum(coalesce(item.unit_price, 0) * item.quantity)
        over (partition by selected.id) as order_list_gross,
      sum(item.quantity)
        over (partition by selected.id) as order_quantity
    from selected_orders as selected
    join public.order_items as item on item.order_id = selected.id
    where item.is_current = true
  ),
  allocated_items as (
    select
      item.order_id,
      item.metric_date,
      item.product_id,
      item.quantity,
      item.sale_fee,
      case
        when item.order_list_gross > 0 then
          item.total_amount * item.line_list_gross / item.order_list_gross
        when item.order_quantity > 0 then
          item.total_amount * item.quantity / item.order_quantity
        else 0
      end::numeric as allocated_gross
    from current_items as item
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
    item.product_id,
    item.metric_date,
    count(distinct item.order_id)::integer,
    sum(item.quantity)::integer,
    sum(item.allocated_gross)::numeric(18, 2),
    sum(item.sale_fee)::numeric(18, 2),
    (sum(item.allocated_gross) - sum(item.sale_fee))::numeric(18, 2),
    (sum(item.allocated_gross) / nullif(sum(item.quantity), 0))::numeric(18, 2)
  from allocated_items as item
  where item.product_id is not null
  group by item.product_id, item.metric_date;

  get diagnostics product_metric_rows = row_count;

  return jsonb_build_object(
    'account_metric_rows', account_metric_rows,
    'product_metric_rows', product_metric_rows,
    'date_from', target_date_from,
    'date_to', target_date_to
  );
end;
$$;

-- Após aplicar a função, reconstruir o histórico em lotes pequenos por conta
-- usando a mesma fila já existente; não executar um UPDATE/REBUILD global em uma
-- única transação. Validar antes/depois que a soma diária de
-- daily_account_metrics.gross_revenue coincide com a soma de orders.total_amount.


-- ============================================================================
-- 2. Índices candidatos para os read models organizacionais
-- ============================================================================
--
-- Estes comandos devem ser executados individualmente, fora de uma transaction
-- block, por usarem CONCURRENTLY. Eles não devem ser copiados sem antes repetir
-- EXPLAIN (ANALYZE, BUFFERS) no volume do ambiente alvo.
--
-- Os índices atuais iniciam por ml_account_id ou product_id. Os dashboards de
-- organização agregam primeiro organization_id + faixa de metric_date.

create index concurrently if not exists daily_account_metrics_org_date_cover_idx
  on public.daily_account_metrics (organization_id, metric_date, ml_account_id)
  include (
    total_orders,
    paid_orders,
    cancelled_orders,
    units_sold,
    mapped_units,
    unmapped_units,
    gross_revenue,
    sale_fees,
    net_after_sale_fee
  );

create index concurrently if not exists daily_product_metrics_org_date_cover_idx
  on public.daily_product_metrics (organization_id, metric_date, product_id, ml_account_id)
  include (orders_count, units_sold, gross_revenue, sale_fees, net_after_sale_fee);


-- ============================================================================
-- 3. Paginar a Central de Alertas no banco
-- ============================================================================
--
-- A função atual get_operational_alerts_data agrega toda a lista em JSON. Esta
-- proposta preserva o resumo global e limita a página antes de serializar. O
-- cursor é estável por (last_seen_at, id). A aplicação precisa migrar seu
-- contrato antes de aposentar a função atual.

create or replace function public.get_operational_alerts_page(
  target_organization_id uuid,
  requested_scope text default 'open',
  requested_limit integer default 100,
  cursor_last_seen_at timestamptz default null,
  cursor_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not private.is_organization_member(target_organization_id) then
    raise exception 'not_authorized';
  end if;

  if requested_scope not in ('open', 'resolved', 'all') then
    raise exception 'invalid_alert_scope';
  end if;

  if requested_limit < 1 or requested_limit > 200 then
    raise exception 'invalid_result_limit';
  end if;

  if (cursor_last_seen_at is null) <> (cursor_id is null) then
    raise exception 'incomplete_cursor';
  end if;

  return jsonb_build_object(
    'summary', (
      select jsonb_build_object(
        'open', count(*) filter (where alert.status = 'open'),
        'critical', count(*) filter (
          where alert.status = 'open' and alert.severity = 'critical'
        ),
        'warning', count(*) filter (
          where alert.status = 'open' and alert.severity = 'warning'
        ),
        'info', count(*) filter (
          where alert.status = 'open' and alert.severity = 'info'
        ),
        'resolved', count(*) filter (where alert.status = 'resolved')
      )
      from public.operational_alerts as alert
      where alert.organization_id = target_organization_id
    ),
    'alerts', coalesce((
      select jsonb_agg(to_jsonb(page_row) order by page_row.last_seen_at desc, page_row.id desc)
      from (
        select
          alert.id,
          alert.product_id,
          alert.alert_type,
          alert.severity,
          alert.status,
          alert.evidence,
          alert.suggested_action_code,
          alert.last_seen_at,
          alert.resolved_at,
          product.sku,
          product.name as product_name
        from public.operational_alerts as alert
        join public.products as product
          on product.organization_id = alert.organization_id
         and product.id = alert.product_id
        where alert.organization_id = target_organization_id
          and (requested_scope = 'all' or alert.status = requested_scope)
          and (
            cursor_last_seen_at is null
            or (alert.last_seen_at, alert.id) < (cursor_last_seen_at, cursor_id)
          )
        order by alert.last_seen_at desc, alert.id desc
        limit requested_limit
      ) as page_row
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_operational_alerts_page(
  uuid, text, integer, timestamptz, uuid
) from public, anon;

grant execute on function public.get_operational_alerts_page(
  uuid, text, integer, timestamptz, uuid
) to authenticated;



-- ============================================================================
-- 4. Limitar a reaquisicao de leases expirados (jobs que nunca falham)
-- ============================================================================
--
-- Problema auditado:
-- claim_next_listings_sync_run (20260810125948_add_resumable_listing_sync.sql:140-204),
-- claim_next_orders_backfill_run (20260810181227_add_orders_backfill_queue.sql:105-158),
-- claim_next_offer_prices_backfill_run (20260814172324_add_offer_prices_backfill_queue.sql:30-50)
-- e claim_next_upseller_import_batch (20260814211000_add_stock_intelligence_workers.sql:21-38)
-- readquirem um run cujo lease expirou SEM incrementar nenhum contador.
--
-- O incremento de retry_count so acontece no bloco catch do worker em Node,
-- por exemplo src/features/ml-sync/process-listings-sync-worker.ts:378-450. Se a
-- Function for morta pelo limite de 60 s (src/app/api/internal/ml-sync/worker/route.ts:20)
-- antes do catch, nada e persistido. O lease expira em 120 s, o proximo dispatch
-- readquire o mesmo run, e o ciclo se repete indefinidamente: o job fica preso em
-- 'running' para sempre, sem nunca atingir max_retries e sem nunca aparecer como
-- falha. ml_offer_refresh_jobs nao tem esse problema porque seu claim ja
-- incrementa attempt_count (20260814175119_finalize_offer_price_background_pipeline.sql:381-386).
--
-- A correcao e contar a reaquisicao no proprio claim, no banco, onde ela sempre
-- acontece. O exemplo abaixo e para listings; replicar o mesmo padrao nas outras
-- tres funcoes antes de aplicar.
--
-- Passos de validacao antes de promover:
-- 1. Conferir com o time se lease_reclaim_count deve compartilhar o teto de
--    max_retries ou ter um teto proprio (sugestao: teto proprio, menor).
-- 2. Aplicar em staging e simular a morte do worker (matar a Function no meio do
--    lote) confirmando que apos N reaquisicoes o run vai para 'failed'.
-- 3. Criar alerta sobre sync_runs em 'failed' com error_code
--    'lease_reclaim_exhausted', que hoje seriam justamente os jobs invisiveis.

alter table public.sync_runs
  add column if not exists lease_reclaim_count integer not null default 0;

create or replace function public.claim_next_listings_sync_run(
  requested_lease_id uuid,
  lease_duration_seconds integer default 120,
  max_lease_reclaims integer default 5
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_run_id uuid;
begin
  if requested_lease_id is null then
    raise exception 'lease_id_required';
  end if;

  if (lease_duration_seconds < 30 or lease_duration_seconds > 300) then
    raise exception 'invalid_lease_duration';
  end if;

  -- Dead-letter: runs que ja esgotaram as reaquisicoes param de ser servidos e
  -- passam a ser visiveis como falha, em vez de girar para sempre.
  update public.sync_runs as sync_run
  set
    status = 'failed',
    lease_id = null,
    lease_expires_at = null,
    error_code = 'lease_reclaim_exhausted',
    error_message = format(
      'O lease expirou %s vezes sem o worker concluir nem registrar falha.',
      sync_run.lease_reclaim_count
    ),
    finished_at = now()
  where sync_run.sync_type = 'listings_full'
    and sync_run.status in ('queued', 'running')
    and sync_run.lease_id is not null
    and sync_run.lease_expires_at <= now()
    and sync_run.lease_reclaim_count >= max_lease_reclaims;

  with candidate as (
    select sync_run.id
    from public.sync_runs as sync_run
    where sync_run.sync_type = 'listings_full'
      and sync_run.status in ('queued', 'running')
      and sync_run.next_attempt_at <= now()
      and (
        sync_run.lease_id is null
        or sync_run.lease_expires_at <= now()
      )
    order by sync_run.started_at asc
    for update skip locked
    limit 1
  )
  update public.sync_runs as sync_run
  set
    status = 'running',
    lease_id = requested_lease_id,
    lease_expires_at = now() + make_interval(secs => lease_duration_seconds),

    -- So conta quando estamos tomando um lease que outro processo abandonou.
    lease_reclaim_count =
      case
        when sync_run.lease_id is not null and sync_run.lease_expires_at <= now()
          then sync_run.lease_reclaim_count + 1
        else sync_run.lease_reclaim_count
      end
  from candidate
  where sync_run.id = candidate.id
  returning sync_run.id into claimed_run_id;

  return claimed_run_id;
end;
$$;

-- O worker deve zerar o contador ao concluir um lote com sucesso, junto do
-- retry_count que ele ja zera hoje:
--   update public.sync_runs set lease_reclaim_count = 0, retry_count = 0 ...
