-- ============================================================
-- /PRODUTOS: SEPARAR SUMMARY DA PÁGINA E ADIAR OS JOINS CAROS
-- ============================================================
--
-- Problema corrigido:
--
-- get_products_overview_data (20260817170000:641-875) media ~6,5 s em
-- produção, perto demais do statement_timeout de 8 s do papel
-- authenticated.
--
-- A causa não é índice: é ordem de trabalho. A função calculava, para
-- TODOS os produtos candidatos e só depois aplicava LIMIT 100:
--
--   - all_offers: varredura de ml_listings + ml_listing_variations,
--     DUPLICANDO o trabalho que private.get_stock_product_signals já faz
--     internamente para os mesmos produtos;
--   - offer_totals: contagem de anúncios ativos por produto;
--   - account_rows + account_totals: jsonb_agg de contas por produto;
--   - prices: min/max de effective_price por produto.
--
-- Nada disso participa do filtro nem da ordenação — são colunas de
-- apresentação. Produzi-las para milhares de produtos e descartar todas
-- menos 100 é o desperdício.
--
-- Correção:
--
--   1. summary vira função própria e barata;
--   2. a página calcula apenas o que o filtro e a ordenação exigem
--      (signals + vendas 30d), aplica LIMIT/OFFSET;
--   3. contas e preços são buscados SOMENTE para os produtos da página;
--   4. active_listings passa a reaproveitar signal.active_offers, em vez
--      de varrer anúncios uma segunda vez.
--
-- A ordenação e o contrato JSON são preservados exatamente, porque a
-- ordenação depende de commercial_status, que depende dos signals — e
-- esses continuam sendo calculados para todos os candidatos, como antes.
-- O ganho vem de não materializar contas, preços e uma segunda varredura
-- de anúncios para linhas que serão descartadas.
--
-- get_products_overview_data é mantida como wrapper compatível.

-- ------------------------------------------------------------
-- 1. SUMMARY
-- ------------------------------------------------------------

create or replace function public.get_products_overview_summary(
  target_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not private.is_organization_member(target_organization_id) then
    raise exception 'not_authorized';
  end if;

  with accessible_accounts as materialized (
    select account.id
    from public.ml_accounts as account
    where account.organization_id = target_organization_id
      and private.can_access_ml_account(account.id)
  ),
  active_offer_products as materialized (
    select distinct listing.product_id
    from public.ml_listings as listing
    join accessible_accounts as account on account.id = listing.ml_account_id
    where listing.organization_id = target_organization_id
      and listing.is_current
      and listing.product_id is not null
      and listing.status = 'active'

    union

    select distinct variation.product_id
    from public.ml_listing_variations as variation
    join accessible_accounts as account on account.id = variation.ml_account_id
    join public.ml_listings as listing
      on listing.organization_id = variation.organization_id
     and listing.id = variation.ml_listing_id
    where variation.organization_id = target_organization_id
      and variation.is_current
      and variation.product_id is not null
      and listing.status = 'active'
  ),
  sales_30 as materialized (
    select
      coalesce(sum(metric.units_sold), 0)::bigint as units_sold,
      coalesce(sum(metric.gross_revenue), 0)::numeric as gross_revenue
    from public.daily_product_metrics as metric
    join accessible_accounts as account on account.id = metric.ml_account_id
    where metric.organization_id = target_organization_id
      and metric.metric_date >= current_date - 30
      and metric.metric_date < current_date
  )
  select jsonb_build_object(
    'totalProducts', (
      select count(*) from public.products as product
      where product.organization_id = target_organization_id
    ),
    'activeProducts', (select count(*) from active_offer_products),
    'unitsSold30', (select units_sold from sales_30),
    'grossRevenue30', (select gross_revenue from sales_30)
  ) into result;

  return result;
end;
$$;

-- ------------------------------------------------------------
-- 2. PÁGINA
-- ------------------------------------------------------------

create or replace function public.get_products_overview_page(
  target_organization_id uuid,
  search_query text default '',
  status_filter text default 'all',
  result_limit integer default 100,
  result_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  safe_limit integer := least(greatest(coalesce(result_limit, 100), 1), 100);
  safe_offset integer := least(greatest(coalesce(result_offset, 0), 0), 100000);
  safe_status text := lower(btrim(coalesce(status_filter, 'all')));
  result jsonb;
begin
  if not private.is_organization_member(target_organization_id) then
    raise exception 'not_authorized';
  end if;

  if safe_status not in ('all', 'with_sales', 'without_sales', 'alerts', 'unmapped', 'conflicts', 'full') then
    raise exception 'invalid_products_filter';
  end if;

  with signals as materialized (
    select *
    from private.get_stock_product_signals(target_organization_id, search_query)
  ),
  sales_30 as materialized (
    select
      metric.product_id,
      sum(metric.units_sold)::bigint as units_sold,
      sum(metric.gross_revenue)::numeric as gross_revenue
    from public.daily_product_metrics as metric
    join public.ml_accounts as account
      on account.id = metric.ml_account_id
     and account.organization_id = target_organization_id
    where metric.organization_id = target_organization_id
      and metric.metric_date >= current_date - 30
      and metric.metric_date < current_date
      and private.can_access_ml_account(account.id)
    group by metric.product_id
  ),
  -- Somente o necessário para filtrar e ordenar. Sem contas, sem preços.
  ranked as materialized (
    select
      signal.*,
      coalesce(sales.units_sold, 0) as units_sold_30,
      coalesce(sales.gross_revenue, 0) as gross_revenue_30,
      case
        when signal.mapping_status = 'conflict' then 'conflict'
        when signal.mapping_status = 'missing' then 'missing'
        when signal.operational_status = 'critical' then 'critical'
        when signal.open_alerts > 0 or signal.operational_status = 'warning' then 'attention'
        else 'healthy'
      end as commercial_status
    from signals as signal
    left join sales_30 as sales on sales.product_id = signal.product_id
  ),
  matching as materialized (
    select ranked.*, count(*) over ()::bigint as match_count
    from ranked
    where safe_status = 'all'
      or (safe_status = 'with_sales' and ranked.units_sold_30 > 0)
      or (safe_status = 'without_sales' and ranked.units_sold_30 = 0)
      or (safe_status = 'alerts' and ranked.open_alerts > 0)
      or (safe_status = 'unmapped' and ranked.mapping_status = 'missing')
      or (safe_status = 'conflicts' and ranked.mapping_status = 'conflict')
      or (safe_status = 'full' and ranked.full_applicable)
  ),
  selected as materialized (
    select *
    from matching
    order by
      case commercial_status
        when 'critical' then 1
        when 'attention' then 2
        when 'conflict' then 3
        when 'missing' then 4
        else 5
      end,
      units_sold_30 desc,
      sku_key,
      product_id
    limit safe_limit
    offset safe_offset
  ),
  -- Daqui para baixo, tudo é restrito aos produtos da página.
  page_accounts as materialized (
    select
      offer.product_id,
      jsonb_agg(
        jsonb_build_object('id', offer.id, 'code', offer.code, 'name', offer.display_name)
        order by offer.display_name, offer.code, offer.id
      ) as accounts
    from (
      select distinct
        selected.product_id,
        account.id,
        account.code,
        account.display_name
      from selected
      join public.ml_listings as listing
        on listing.organization_id = target_organization_id
       and listing.product_id = selected.product_id
       and listing.is_current
      join public.ml_accounts as account
        on account.id = listing.ml_account_id
       and account.organization_id = target_organization_id
      where private.can_access_ml_account(account.id)

      union

      select distinct
        selected.product_id,
        account.id,
        account.code,
        account.display_name
      from selected
      join public.ml_listing_variations as variation
        on variation.organization_id = target_organization_id
       and variation.product_id = selected.product_id
       and variation.is_current
      join public.ml_accounts as account
        on account.id = variation.ml_account_id
       and account.organization_id = target_organization_id
      where private.can_access_ml_account(account.id)
    ) as offer
    group by offer.product_id
  ),
  page_prices as materialized (
    select
      price.product_id,
      min(price.effective_price) as minimum_price,
      max(price.effective_price) as maximum_price
    from public.ml_offer_price_states as price
    join selected on selected.product_id = price.product_id
    join public.ml_accounts as account
      on account.id = price.ml_account_id
     and account.organization_id = target_organization_id
    where price.organization_id = target_organization_id
      and price.product_id is not null
      and price.effective_price is not null
      and private.can_access_ml_account(account.id)
    group by price.product_id
  )
  select jsonb_build_object(
    'matchCount', coalesce((select max(match_count) from matching), 0),
    'products', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', selected.product_id,
          'sku', selected.sku,
          'name', selected.product_name,
          'accounts', coalesce(page_account.accounts, '[]'::jsonb),
          'activeListings', selected.active_offers,
          'unitsSold30', selected.units_sold_30,
          'grossRevenue30', selected.gross_revenue_30,
          'minimumPrice', page_price.minimum_price,
          'maximumPrice', page_price.maximum_price,
          'physicalReady', selected.physical_ready,
          'physicalAvailable', selected.physical_available,
          'fullApplicable', selected.full_applicable,
          'fullAvailable', selected.full_available,
          'mappingStatus', selected.mapping_status,
          'openAlerts', selected.open_alerts,
          'alertSeverity', selected.alert_severity,
          'status', selected.commercial_status
        )
        order by
          case selected.commercial_status
            when 'critical' then 1
            when 'attention' then 2
            when 'conflict' then 3
            when 'missing' then 4
            else 5
          end,
          selected.units_sold_30 desc,
          selected.sku_key,
          selected.product_id
      )
      from selected
      left join page_accounts as page_account on page_account.product_id = selected.product_id
      left join page_prices as page_price on page_price.product_id = selected.product_id
    ), '[]'::jsonb),
    'limit', safe_limit,
    'offset', safe_offset
  ) into result;

  return result;
end;
$$;

-- ------------------------------------------------------------
-- 3. WRAPPER COMPATÍVEL
-- ------------------------------------------------------------
--
-- Mantido para não quebrar nenhum consumidor que ainda chame a função
-- antiga. Passa a compor as duas funções novas.

create or replace function public.get_products_overview_data(
  target_organization_id uuid,
  search_query text default '',
  status_filter text default 'all',
  result_limit integer default 100,
  result_offset integer default 0
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.get_products_overview_page(
      target_organization_id, search_query, status_filter, result_limit, result_offset
    )
    || jsonb_build_object(
      'summary', public.get_products_overview_summary(target_organization_id)
    );
$$;

revoke all on function public.get_products_overview_summary(uuid) from public, anon;
revoke all on function public.get_products_overview_page(uuid, text, text, integer, integer) from public, anon;

grant execute on function public.get_products_overview_summary(uuid) to authenticated;
grant execute on function public.get_products_overview_page(uuid, text, text, integer, integer) to authenticated;
