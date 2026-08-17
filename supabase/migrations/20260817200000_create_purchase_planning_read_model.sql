-- ============================================================
-- PLANEJAMENTO DE COMPRA POR SKU FÍSICO
-- ============================================================
--
-- A recomendação de compra é por SKU FÍSICO do UpSeller, nunca por MLB,
-- listing, conta ou product canônico isolado. Vários products podem
-- apontar para o mesmo source_sku_key; as vendas somam e o SKU aparece
-- uma única vez.
--
-- Regras de domínio espelhadas de src/features/stock/stock-domain.ts
-- (calculatePurchaseRecommendation e buildPhysicalDemand), que são a
-- especificação testada. O SQL calcula aqui porque filtro, ordenação e
-- paginação precisam do resultado ANTES do LIMIT; a aplicação recalcula
-- as linhas exibidas com a função pura, de modo que o número mostrado ao
-- usuário sempre vem do código coberto por teste.
--
-- Decisões preservadas do domínio existente:
--
-- - Full NÃO entra no cálculo. Físico e Full são pools separados.
-- - transfer_in_transit é exibido mas não reduz a sugestão: é
--   movimentação interna e consolidar warehouses poderia contar duas
--   vezes. purchase_in_transit reduz, porque é mercadoria já comprada.
-- - Janela de 30 dias COMPLETOS anteriores a hoje, em America/Sao_Paulo,
--   sem incluir o dia corrente parcial.
-- - salesVelocityReady exige cobertura comprovada de backfill; sem isso
--   não se extrapola, devolve-se "histórico insuficiente".
-- - Lead time: OFF RACER / OFFRACER / NAVETEC = 90 dias, demais = 15.
--   Mesma regra de purchaseLeadTimeDays, pela marca do SKU FÍSICO que
--   será comprado (num kit, a marca de cada componente).

-- ------------------------------------------------------------
-- LEAD TIME
-- ------------------------------------------------------------
--
-- Espelha purchaseLeadTimeDays de stock-domain.ts. A normalização
-- remove tudo que não é alfanumérico antes de comparar, de modo que
-- "OFF RACER", "Off-Racer" e "offracer" caiam no mesmo valor — mesma
-- intenção do normalizeKey do TypeScript, que também colapsa
-- separadores e maiúsculas.

create or replace function private.purchase_lead_time_days(brand text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when regexp_replace(upper(coalesce(brand, '')), '[^A-Z0-9]', '', 'g')
      in ('OFFRACER', 'NAVETEC')
    then 90
    else 15
  end;
$$;

create or replace function private.get_purchase_planning_signals(
  target_organization_id uuid
)
returns table (
  source_sku text,
  source_sku_key text,
  title text,
  brand text,
  physical_available numeric,
  physical_current numeric,
  occupied_quantity numeric,
  purchase_in_transit numeric,
  transfer_in_transit numeric,
  low_stock_threshold numeric,
  direct_units_sold_30 numeric,
  kit_units_consumed_30 numeric,
  physical_units_consumed_30 numeric,
  avg_daily_sales_30 numeric,
  sales_velocity_ready boolean,
  coverage_days numeric,
  lead_time_days integer,
  demand_during_lead_time numeric,
  target_reserve numeric,
  projected_stock_at_arrival numeric,
  suggested_purchase_quantity numeric,
  status text,
  planning_issue text,
  source_products_count bigint,
  source_product_ids uuid[],
  unit_cost numeric,
  estimated_purchase_value numeric,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  period_to date := ((now() at time zone 'America/Sao_Paulo')::date - 1);
  period_from date := ((now() at time zone 'America/Sao_Paulo')::date - 30);
begin
  if not private.is_organization_member(target_organization_id) then
    raise exception 'not_authorized';
  end if;

  return query
  with accessible_accounts as materialized (
    select account.id
    from public.ml_accounts as account
    where account.organization_id = target_organization_id
      and private.can_access_ml_account(account.id)
  ),

  -- Vínculo físico ativo. Produtos em conflito de vínculo ficam de fora
  -- da recomendação automática: não há source físico confiável.
  links as materialized (
    select
      link.product_id,
      link.source_sku,
      link.source_sku_key,
      link.source_kind
    from public.product_inventory_links as link
    where link.organization_id = target_organization_id
      and link.source = 'upseller'
      and link.is_active
      and not exists (
        select 1
        from public.product_inventory_link_conflicts as conflict
        where conflict.organization_id = target_organization_id
          and conflict.product_id = link.product_id
          and conflict.source = 'upseller'
          and conflict.is_current
      )
  ),

  -- Vendas de 30 dias completos por product, uma linha por product.
  product_sales as materialized (
    select
      metric.product_id,
      sum(metric.units_sold)::numeric as units_sold_30
    from public.daily_product_metrics as metric
    join accessible_accounts as account on account.id = metric.ml_account_id
    where metric.organization_id = target_organization_id
      and metric.metric_date between period_from and period_to
    group by metric.product_id
  ),

  -- Contas que anunciam cada product, para avaliar cobertura de histórico.
  product_accounts as materialized (
    select distinct listing.product_id, listing.ml_account_id
    from public.ml_listings as listing
    join accessible_accounts as account on account.id = listing.ml_account_id
    where listing.organization_id = target_organization_id
      and listing.is_current
      and listing.product_id is not null

    union

    select distinct variation.product_id, variation.ml_account_id
    from public.ml_listing_variations as variation
    join accessible_accounts as account on account.id = variation.ml_account_id
    where variation.organization_id = target_organization_id
      and variation.is_current
      and variation.product_id is not null
  ),

  covered_accounts as materialized (
    select distinct run.ml_account_id
    from public.sync_runs as run
    where run.organization_id = target_organization_id
      and run.sync_type = 'orders_dashboard_backfill'
      and run.status = 'succeeded'
      and (run.metadata ->> 'covered_from') is not null
      and (run.metadata ->> 'covered_from') <= period_from::text
  ),

  -- historyReady por product: precisa ter ao menos uma conta anunciando e
  -- TODAS elas com backfill cobrindo o início da janela.
  product_history as materialized (
    select
      product_account.product_id,
      count(*) > 0
        and count(*) = count(covered.ml_account_id) as history_ready
    from product_accounts as product_account
    left join covered_accounts as covered
      on covered.ml_account_id = product_account.ml_account_id
    group by product_account.product_id
  ),

  -- Confiabilidade da composição do kit: mesma definição usada em
  -- private.get_stock_product_signals.
  kit_reliability as materialized (
    select
      component.kit_sku_key,
      count(*) > 0
        and bool_and(component_state.sku_key is not null)
        and not bool_or(nested_kit.kit_sku_key is not null) as reliable
    from public.upseller_kit_components as component
    left join (
      select distinct state.sku_key
      from public.upseller_stock_states as state
      where state.organization_id = target_organization_id
    ) as component_state
      on component_state.sku_key = component.component_sku_key
    left join public.upseller_kits as nested_kit
      on nested_kit.organization_id = target_organization_id
     and nested_kit.kit_sku_key = component.component_sku_key
     and nested_kit.is_current
    where component.organization_id = target_organization_id
      and component.is_current
    group by component.kit_sku_key
  ),

  -- ------------------------------------------------------------
  -- ÁRVORE DE DEMANDA FÍSICA
  -- ------------------------------------------------------------
  -- Cada product contribui UMA única vez. Simples vai direto para o seu
  -- SKU; kit distribui entre componentes pela quantidade requerida.

  simple_demand as materialized (
    select
      link.source_sku_key,
      coalesce(sales.units_sold_30, 0) as direct_units,
      0::numeric as kit_units,
      link.product_id,
      null::text as planning_issue
    from links as link
    left join product_sales as sales on sales.product_id = link.product_id
    where link.source_kind = 'simple'
  ),

  kit_demand as materialized (
    select
      component.component_sku_key as source_sku_key,
      0::numeric as direct_units,
      coalesce(sales.units_sold_30, 0) * component.required_quantity as kit_units,
      link.product_id,
      null::text as planning_issue
    from links as link
    join kit_reliability as reliability
      on reliability.kit_sku_key = link.source_sku_key
     and reliability.reliable
    join public.upseller_kit_components as component
      on component.organization_id = target_organization_id
     and component.kit_sku_key = link.source_sku_key
     and component.is_current
    left join product_sales as sales on sales.product_id = link.product_id
    where link.source_kind = 'kit'
  ),

  -- Kit sem composição confiável não distribui demanda: aparece para
  -- explicar o problema, sem gerar compra automática.
  unresolved_kit_demand as materialized (
    select
      link.source_sku_key,
      0::numeric as direct_units,
      0::numeric as kit_units,
      link.product_id,
      'kit_components_unknown'::text as planning_issue
    from links as link
    left join kit_reliability as reliability
      on reliability.kit_sku_key = link.source_sku_key
    where link.source_kind = 'kit'
      and coalesce(reliability.reliable, false) = false
  ),

  demand as materialized (
    select * from simple_demand
    union all
    select * from kit_demand
    union all
    select * from unresolved_kit_demand
  ),

  demand_by_sku as materialized (
    select
      demand.source_sku_key,
      sum(demand.direct_units) as direct_units_sold_30,
      sum(demand.kit_units) as kit_units_consumed_30,
      count(distinct demand.product_id)::bigint as source_products_count,
      array_agg(distinct demand.product_id) as source_product_ids,
      max(demand.planning_issue) as planning_issue,
      bool_and(coalesce(history.history_ready, false)) as history_ready
    from demand
    left join product_history as history on history.product_id = demand.product_id
    group by demand.source_sku_key
  ),

  -- ------------------------------------------------------------
  -- ESTOQUE FÍSICO AGREGADO
  -- ------------------------------------------------------------

  receipt_adjustments as materialized (
    select
      adjustment.sku_key,
      adjustment.warehouse_key,
      sum(adjustment.quantity) as quantity,
      max(adjustment.applied_at) as applied_at
    from public.current_stock_receipt_adjustments as adjustment
    where adjustment.organization_id = target_organization_id
    group by adjustment.sku_key, adjustment.warehouse_key
  ),

  stock_by_sku as materialized (
    select
      state.sku_key,
      max(state.source_sku) as source_sku,
      max(state.title) as title,
      sum(state.available_quantity + coalesce(adjustment.quantity, 0)) as available_quantity,
      sum(state.current_quantity + coalesce(adjustment.quantity, 0)) as current_quantity,
      sum(state.occupied_quantity) as occupied_quantity,
      sum(state.purchase_in_transit) as purchase_in_transit,
      sum(state.transfer_in_transit) as transfer_in_transit,
      sum(state.low_stock_threshold) as low_stock_threshold,
      -- Média ponderada por quantidade; nula se algum depósito não
      -- souber o custo, para não fingir precisão.
      case
        when bool_and(state.average_cost is not null) then
          case
            when sum(state.current_quantity) > 0
              then sum(state.average_cost * state.current_quantity) / sum(state.current_quantity)
            else avg(state.average_cost)
          end
      end as average_cost,
      max(greatest(state.checked_at, adjustment.applied_at)) as updated_at
    from public.upseller_stock_states as state
    left join receipt_adjustments as adjustment
      on adjustment.sku_key = state.sku_key
     and adjustment.warehouse_key = state.warehouse_key
    where state.organization_id = target_organization_id
    group by state.sku_key
  ),

  catalog as materialized (
    select
      product_catalog.sku_key,
      max(product_catalog.brand) as brand,
      max(product_catalog.title) as title,
      max(product_catalog.source_sku) as source_sku,
      max(product_catalog.purchase_cost) as purchase_cost
    from public.upseller_product_catalog as product_catalog
    where product_catalog.organization_id = target_organization_id
    group by product_catalog.sku_key
  ),

  computed as (
    select
      coalesce(stock.source_sku, catalog.source_sku, demand_by_sku.source_sku_key) as source_sku,
      demand_by_sku.source_sku_key,
      coalesce(stock.title, catalog.title) as title,
      catalog.brand,
      stock.available_quantity as physical_available,
      stock.current_quantity as physical_current,
      stock.occupied_quantity,
      coalesce(stock.purchase_in_transit, 0) as purchase_in_transit,
      coalesce(stock.transfer_in_transit, 0) as transfer_in_transit,
      stock.low_stock_threshold,
      demand_by_sku.direct_units_sold_30,
      demand_by_sku.kit_units_consumed_30,
      (demand_by_sku.direct_units_sold_30 + demand_by_sku.kit_units_consumed_30) as physical_units_consumed_30,
      demand_by_sku.history_ready,
      demand_by_sku.planning_issue,
      demand_by_sku.source_products_count,
      demand_by_sku.source_product_ids,
      private.purchase_lead_time_days(catalog.brand) as lead_time_days,
      greatest(coalesce(stock.low_stock_threshold, 0), 0) as target_reserve,
      coalesce(stock.average_cost, catalog.purchase_cost) as unit_cost,
      stock.updated_at
    from demand_by_sku
    left join stock_by_sku as stock on stock.sku_key = demand_by_sku.source_sku_key
    left join catalog on catalog.sku_key = demand_by_sku.source_sku_key
  ),

  final as (
    select
      computed.*,
      -- salesVelocityReady exige histórico coberto E estoque físico
      -- conhecido; sem um dos dois não se calcula sugestão.
      (
        computed.history_ready
        and computed.physical_available is not null
        and computed.planning_issue is null
      ) as sales_velocity_ready,
      case
        when computed.history_ready
        then computed.physical_units_consumed_30 / 30.0
      end as avg_daily_sales_30
    from computed
  )

  select
    final.source_sku,
    final.source_sku_key,
    final.title,
    final.brand,
    final.physical_available,
    final.physical_current,
    final.occupied_quantity,
    final.purchase_in_transit,
    final.transfer_in_transit,
    final.low_stock_threshold,
    final.direct_units_sold_30,
    final.kit_units_consumed_30,
    final.physical_units_consumed_30,
    final.avg_daily_sales_30,
    final.sales_velocity_ready,
    case
      when final.sales_velocity_ready and coalesce(final.avg_daily_sales_30, 0) > 0
      then final.physical_available / final.avg_daily_sales_30
    end as coverage_days,
    final.lead_time_days,
    case
      when final.sales_velocity_ready and coalesce(final.avg_daily_sales_30, 0) > 0
      then final.avg_daily_sales_30 * final.lead_time_days
      when final.sales_velocity_ready then 0
    end as demand_during_lead_time,
    final.target_reserve,
    case
      when final.sales_velocity_ready and coalesce(final.avg_daily_sales_30, 0) > 0
      then final.physical_available + final.purchase_in_transit
           - (final.avg_daily_sales_30 * final.lead_time_days)
      when final.sales_velocity_ready
      then final.physical_available + final.purchase_in_transit
    end as projected_stock_at_arrival,
    case
      when not final.sales_velocity_ready then null
      when coalesce(final.avg_daily_sales_30, 0) <= 0 then 0
      else ceil(greatest(
        0,
        (final.avg_daily_sales_30 * final.lead_time_days)
        + final.target_reserve
        - final.physical_available
        - final.purchase_in_transit
      ))
    end as suggested_purchase_quantity,
    case
      when final.planning_issue is not null then 'mapping_issue'
      when not final.sales_velocity_ready then 'insufficient_data'
      when coalesce(final.avg_daily_sales_30, 0) <= 0 then 'no_sales'
      when ceil(greatest(
        0,
        (final.avg_daily_sales_30 * final.lead_time_days)
        + final.target_reserve
        - final.physical_available
        - final.purchase_in_transit
      )) > 0
        then case when final.physical_available <= 0 then 'urgent' else 'due' end
      else 'covered'
    end as status,
    final.planning_issue,
    final.source_products_count,
    final.source_product_ids,
    final.unit_cost,
    case
      when final.unit_cost is not null
        and final.sales_velocity_ready
        and coalesce(final.avg_daily_sales_30, 0) > 0
      then final.unit_cost * ceil(greatest(
        0,
        (final.avg_daily_sales_30 * final.lead_time_days)
        + final.target_reserve
        - final.physical_available
        - final.purchase_in_transit
      ))
    end as estimated_purchase_value,
    final.updated_at
  from final;
end;
$$;

revoke all on function private.get_purchase_planning_signals(uuid)
from public, anon, authenticated;
