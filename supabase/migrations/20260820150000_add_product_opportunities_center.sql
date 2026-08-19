-- ETAPA 37: Central de Oportunidades.
--
-- A deterministic, set-based SQL scanner (no per-product RPC calls, no
-- Mercado Livre/Anthropic calls) evaluates the whole eligible product
-- universe in one pass and upserts public.product_opportunities. Claude is
-- never part of the scan — it only gets invoked afterward, on-demand
-- (button) or auto-selected within a strict daily budget (organization_ai_settings),
-- by reusing the EXISTING product_diagnostic_jobs queue from ETAPA 36/36.1
-- unchanged.
--
-- Reuses rather than re-derives: operational_alerts for stock/Full/purchase/
-- mapping signals, private.get_purchase_planning_signals for coverage/lead
-- time, product_market_research_runs (cache only, never fetched live here)
-- for price/listing-quality signals, daily_product_metrics for the same
-- sales-drop thresholds as product-diagnostic-domain.ts's
-- classifySalesTrigger (previous7>=3 & drop>=30%; previous30>=5 & drop>=30%).

create table public.organization_ai_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  auto_opportunity_diagnostics_enabled boolean not null default false,
  daily_opportunity_diagnostic_limit integer not null default 5 check (daily_opportunity_diagnostic_limit between 1 and 20),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

alter table public.organization_ai_settings enable row level security;

create policy organization_ai_settings_select_members
  on public.organization_ai_settings
  for select
  to authenticated
  using (private.is_organization_member(organization_id));

create table public.product_opportunity_scan_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  phase text not null default 'scanning',
  scanned_products integer not null default 0,
  opened integer not null default 0,
  updated integer not null default 0,
  resolved integer not null default 0,
  errors integer not null default 0,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text,
  error_message text
);

alter table public.product_opportunity_scan_runs enable row level security;

create policy product_opportunity_scan_runs_select_members
  on public.product_opportunity_scan_runs
  for select
  to authenticated
  using (private.is_organization_member(organization_id));

create table public.product_opportunities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  product_id uuid not null,
  opportunity_type text not null check (opportunity_type in (
    'SALES_DROP', 'NO_SALES_WITH_AVAILABILITY', 'ACCOUNT_SPECIFIC_DROP', 'PHYSICAL_STOCKOUT_WITH_DEMAND',
    'FULL_ZERO_WITH_PHYSICAL', 'PURCHASE_URGENT', 'GROWTH_LOW_COVERAGE', 'PROMOTION_ENDED_SALES_DROP',
    'PRICE_NOT_COMPETITIVE', 'LISTING_QUALITY', 'MAPPING_BLOCKER'
  )),
  ml_account_id uuid references public.ml_accounts(id) on delete cascade,
  item_id text,
  scope_type text not null check (scope_type in ('product', 'account', 'listing')),
  status text not null default 'open' check (status in ('open', 'snoozed', 'dismissed', 'resolved')),
  priority text not null check (priority in ('critical', 'high', 'medium', 'low')),
  score numeric not null default 0,
  fingerprint text not null,
  title text not null,
  summary text not null,
  evidence jsonb not null default '{}'::jsonb,
  evidence_hash text not null,
  primary_action_code text,
  primary_action_text text,
  latest_diagnostic_run_id uuid references public.product_diagnostic_runs(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_evaluated_at timestamptz not null default now(),
  resolved_at timestamptz,
  snoozed_until timestamptz,
  dismissed_at timestamptz,
  dismissed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, product_id) references public.products(organization_id, id) on delete cascade
);

-- One row per fingerprint, ever — status toggles instead of new rows, so
-- history (first_seen_at, dismissed_at, resolved cycles) is preserved.
create unique index product_opportunities_fingerprint_idx on public.product_opportunities (organization_id, fingerprint);
create index product_opportunities_list_idx on public.product_opportunities (organization_id, status, priority, last_seen_at desc);
create index product_opportunities_product_idx on public.product_opportunities (organization_id, product_id, status);
create index product_opportunities_type_idx on public.product_opportunities (organization_id, opportunity_type, status);

alter table public.product_opportunities enable row level security;

-- Account-scoped rows are only visible to members who can see that
-- ml_account (mirrors can_access_ml_account elsewhere); product-scoped rows
-- (ml_account_id is null) are visible to any organization member.
create policy product_opportunities_select_members
  on public.product_opportunities
  for select
  to authenticated
  using (
    private.is_organization_member(organization_id)
    and (ml_account_id is null or private.can_access_ml_account(ml_account_id))
  );

create table public.product_opportunity_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  opportunity_id uuid not null references public.product_opportunities(id) on delete cascade,
  event_type text not null check (event_type in ('opened', 'updated', 'snoozed', 'reopened', 'dismissed', 'resolved', 'diagnostic_linked')),
  actor_id uuid references auth.users(id),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index product_opportunity_events_opportunity_idx on public.product_opportunity_events (opportunity_id, created_at desc);

alter table public.product_opportunity_events enable row level security;

create policy product_opportunity_events_select_members
  on public.product_opportunity_events
  for select
  to authenticated
  using (private.is_organization_member(organization_id));

-- Deterministic, set-based scan. No Mercado Livre or Anthropic calls — only
-- this database. Every opportunity type reuses an existing signal:
-- operational_alerts (stock/Full/purchase/mapping), private.get_purchase_planning_signals
-- (coverage/lead time), product_market_research_runs cache only (never
-- fetched live here), and the same sales-drop thresholds as
-- product-diagnostic-domain.ts's classifySalesTrigger.
create or replace function public.scan_product_opportunities(target_organization_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  as_of_date date := ((now() at time zone 'America/Sao_Paulo')::date - 1);
  caller_role text := coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '');
  scan_id uuid;
  scanned_count integer := 0;
  opened_count integer := 0;
  updated_count integer := 0;
  resolved_count integer := 0;
begin
  if not (private.is_organization_member(target_organization_id) or caller_role = 'service_role') then
    raise exception 'not_authorized';
  end if;

  insert into public.product_opportunity_scan_runs (organization_id, status, phase)
  values (target_organization_id, 'running', 'scanning')
  returning id into scan_id;

  create temporary table tmp_eligible_products on commit drop as
  select distinct product.id as product_id
  from public.products as product
  where product.organization_id = target_organization_id
    and (
      exists (select 1 from public.ml_listings l where l.organization_id = product.organization_id and l.product_id = product.id and l.is_current)
      or exists (select 1 from public.ml_listing_variations v where v.organization_id = product.organization_id and v.product_id = product.id and v.is_current)
      or exists (select 1 from public.daily_product_metrics m where m.organization_id = product.organization_id and m.product_id = product.id and m.metric_date >= as_of_date - 89)
      or exists (select 1 from public.operational_alerts a where a.organization_id = product.organization_id and a.product_id = product.id and a.status = 'open')
      or exists (select 1 from public.product_inventory_links pil where pil.organization_id = product.organization_id and pil.product_id = product.id and pil.is_active and pil.source = 'upseller')
    );

  select count(*) into scanned_count from tmp_eligible_products;

  create temporary table tmp_candidates on commit drop as
  with
  sales_totals as materialized (
    select
      m.product_id,
      coalesce(sum(m.units_sold) filter (where m.metric_date between as_of_date - 6 and as_of_date), 0)::numeric as units7,
      coalesce(sum(m.units_sold) filter (where m.metric_date between as_of_date - 13 and as_of_date - 7), 0)::numeric as previous_units7,
      coalesce(sum(m.gross_revenue) filter (where m.metric_date between as_of_date - 6 and as_of_date), 0)::numeric as revenue7,
      coalesce(sum(m.gross_revenue) filter (where m.metric_date between as_of_date - 13 and as_of_date - 7), 0)::numeric as previous_revenue7,
      coalesce(sum(m.units_sold) filter (where m.metric_date between as_of_date - 29 and as_of_date), 0)::numeric as units30,
      coalesce(sum(m.units_sold) filter (where m.metric_date between as_of_date - 59 and as_of_date - 30), 0)::numeric as previous_units30,
      coalesce(sum(m.units_sold) filter (where m.metric_date between as_of_date - 89 and as_of_date), 0)::numeric as units90
    from public.daily_product_metrics as m
    join tmp_eligible_products ep on ep.product_id = m.product_id
    where m.organization_id = target_organization_id
      and m.metric_date between as_of_date - 89 and as_of_date
    group by m.product_id
  ),
  sales_by_account as materialized (
    select
      m.product_id, m.ml_account_id,
      coalesce(sum(m.units_sold) filter (where m.metric_date between as_of_date - 6 and as_of_date), 0)::numeric as units7,
      coalesce(sum(m.units_sold) filter (where m.metric_date between as_of_date - 13 and as_of_date - 7), 0)::numeric as previous_units7
    from public.daily_product_metrics as m
    join tmp_eligible_products ep on ep.product_id = m.product_id
    where m.organization_id = target_organization_id
      and m.metric_date between as_of_date - 13 and as_of_date
    group by m.product_id, m.ml_account_id
  ),
  product_availability as materialized (
    select
      p.id as product_id,
      exists(select 1 from public.ml_listings l where l.organization_id = p.organization_id and l.product_id = p.id and l.is_current and l.status = 'active') as has_active_listing,
      coalesce((
        select sum(s.available_quantity) from public.upseller_stock_states s
        join public.product_inventory_links pil on pil.organization_id = p.organization_id and pil.product_id = p.id and pil.is_active and pil.source = 'upseller' and pil.source_kind = 'simple'
        where s.organization_id = p.organization_id and s.sku_key = pil.source_sku_key
      ), 0) as physical_available,
      coalesce((
        select sum(f.available_quantity) from public.ml_fulfillment_stock_states f
        join public.ml_listings l on l.organization_id = p.organization_id and l.product_id = p.id and l.is_current and l.inventory_id = f.inventory_id and l.ml_account_id = f.ml_account_id
        where f.organization_id = p.organization_id
      ), 0) as full_available
    from public.products p
    join tmp_eligible_products ep on ep.product_id = p.id
    where p.organization_id = target_organization_id
  ),
  planning_signals as materialized (
    select * from private.get_purchase_planning_signals(target_organization_id)
  ),
  fresh_official_market as materialized (
    select distinct on (product_id) product_id, data
    from public.product_market_research_runs
    where organization_id = target_organization_id and kind = 'official_ml' and status = 'succeeded' and expires_at > now()
    order by product_id, fetched_at desc
  ),

  -- 1. SALES_DROP
  sales_drop_candidates (opportunity_type, product_id, ml_account_id, item_id, scope_type, priority, score, fingerprint, title, summary, evidence) as (
    select
      'SALES_DROP'::text, st.product_id, null::uuid, null::text, 'product'::text,
      (case
        when st.previous_units7 >= 3 and st.units7 = 0 then 'critical'
        when (st.previous_units7 >= 3 and st.units7 < st.previous_units7 and (st.previous_units7 - st.units7) / nullif(st.previous_units7, 0) >= 0.5)
          or (st.previous_units30 >= 5 and st.units30 < st.previous_units30 and (st.previous_units30 - st.units30) / nullif(st.previous_units30, 0) >= 0.5)
          then 'high'
        else 'medium'
      end)::text as priority,
      greatest(coalesce(st.previous_units7 - st.units7, 0), coalesce(st.previous_units30 - st.units30, 0)) as score,
      'SALES_DROP:' || st.product_id as fingerprint,
      'Queda de vendas'::text as title,
      format('Vendas: %s -> %s unidades (7 dias); %s -> %s (30 dias).', st.previous_units7, st.units7, st.previous_units30, st.units30) as summary,
      jsonb_build_object(
        'units7', st.units7, 'previousUnits7', st.previous_units7, 'revenue7', st.revenue7, 'previousRevenue7', st.previous_revenue7,
        'units30', st.units30, 'previousUnits30', st.previous_units30,
        'observedUnitsDecline7', greatest(st.previous_units7 - st.units7, 0),
        'observedRevenueDecline7', greatest(st.previous_revenue7 - st.revenue7, 0),
        'observedUnitsDecline30', greatest(st.previous_units30 - st.units30, 0)
      ) as evidence
    from sales_totals st
    where (st.previous_units7 >= 3 and st.units7 < st.previous_units7 and (st.previous_units7 - st.units7) / nullif(st.previous_units7, 0) >= 0.3)
       or (st.previous_units30 >= 5 and st.units30 < st.previous_units30 and (st.previous_units30 - st.units30) / nullif(st.previous_units30, 0) >= 0.3)
  ),

  -- 2. NO_SALES_WITH_AVAILABILITY
  no_sales_candidates (opportunity_type, product_id, ml_account_id, item_id, scope_type, priority, score, fingerprint, title, summary, evidence) as (
    select
      'NO_SALES_WITH_AVAILABILITY', st.product_id, null::uuid, null::text, 'product',
      'medium',
      0::numeric,
      'NO_SALES_WITH_AVAILABILITY:' || st.product_id,
      'Sem vendas apesar de disponibilidade',
      format('Sem vendas nos ultimos 30 dias, mas ha disponibilidade (fisico: %s, Full: %s, anuncio ativo: %s).', pa.physical_available, pa.full_available, pa.has_active_listing),
      jsonb_build_object('units30', st.units30, 'units90', st.units90, 'physicalAvailable', pa.physical_available, 'fullAvailable', pa.full_available, 'hasActiveListing', pa.has_active_listing)
    from sales_totals st
    join product_availability pa on pa.product_id = st.product_id
    where st.units30 = 0 and st.units90 > 0
      and pa.has_active_listing
      and (pa.physical_available > 0 or pa.full_available > 0)
  ),

  -- 3. ACCOUNT_SPECIFIC_DROP
  account_specific_candidates (opportunity_type, product_id, ml_account_id, item_id, scope_type, priority, score, fingerprint, title, summary, evidence) as (
    select
      'ACCOUNT_SPECIFIC_DROP', sba.product_id, sba.ml_account_id, null::text, 'account',
      (case when (sba.previous_units7 - sba.units7) / nullif(sba.previous_units7, 0) >= 0.7 then 'high' else 'medium' end)::text,
      coalesce(sba.previous_units7 - sba.units7, 0),
      'ACCOUNT_SPECIFIC_DROP:' || sba.product_id || ':' || sba.ml_account_id,
      'Queda concentrada em uma conta',
      format('Conta %s: vendas cairam de %s para %s unidades (7 dias), enquanto o produto no geral nao caiu.', acc.display_name, sba.previous_units7, sba.units7),
      jsonb_build_object('accountCode', acc.code, 'units7', sba.units7, 'previousUnits7', sba.previous_units7)
    from sales_by_account sba
    join public.ml_accounts acc on acc.id = sba.ml_account_id
    join sales_totals st on st.product_id = sba.product_id
    where sba.previous_units7 >= 3 and sba.units7 < sba.previous_units7
      and (sba.previous_units7 - sba.units7) / nullif(sba.previous_units7, 0) >= 0.3
      and not (st.previous_units7 >= 3 and st.units7 < st.previous_units7 and (st.previous_units7 - st.units7) / nullif(st.previous_units7, 0) >= 0.3)
  ),

  -- 4-7. reused directly from operational_alerts (never a second interpretation of the same signal)
  alert_candidates (opportunity_type, product_id, ml_account_id, item_id, scope_type, priority, score, fingerprint, title, summary, evidence) as (
    select
      (case a.alert_type
        when 'PHYSICAL_OUT_OF_STOCK' then 'PHYSICAL_STOCKOUT_WITH_DEMAND'
        when 'FULL_REPLENISH_FROM_PHYSICAL' then 'FULL_ZERO_WITH_PHYSICAL'
        when 'PURCHASE_REPLENISHMENT_REQUIRED' then 'PURCHASE_URGENT'
        when 'PURCHASE_REPLENISHMENT_DUE' then 'PURCHASE_URGENT'
        when 'STOCK_MAPPING_CONFLICT' then 'MAPPING_BLOCKER'
        when 'STOCK_MAPPING_MISSING' then 'MAPPING_BLOCKER'
      end)::text as opportunity_type,
      a.product_id, null::uuid, null::text, 'product'::text,
      (case a.severity when 'critical' then 'critical' when 'warning' then 'high' else 'medium' end)::text,
      (case a.severity when 'critical' then 3 when 'warning' then 2 else 1 end)::numeric,
      (case a.alert_type
        when 'PHYSICAL_OUT_OF_STOCK' then 'PHYSICAL_STOCKOUT_WITH_DEMAND'
        when 'FULL_REPLENISH_FROM_PHYSICAL' then 'FULL_ZERO_WITH_PHYSICAL'
        when 'PURCHASE_REPLENISHMENT_REQUIRED' then 'PURCHASE_URGENT'
        when 'PURCHASE_REPLENISHMENT_DUE' then 'PURCHASE_URGENT'
        when 'STOCK_MAPPING_CONFLICT' then 'MAPPING_BLOCKER'
        when 'STOCK_MAPPING_MISSING' then 'MAPPING_BLOCKER'
      end) || ':' || a.product_id,
      (case a.alert_type
        when 'PHYSICAL_OUT_OF_STOCK' then 'Estoque fisico zerado com demanda'
        when 'FULL_REPLENISH_FROM_PHYSICAL' then 'Full zerado com estoque fisico disponivel'
        when 'PURCHASE_REPLENISHMENT_REQUIRED' then 'Compra urgente'
        when 'PURCHASE_REPLENISHMENT_DUE' then 'Compra urgente'
        when 'STOCK_MAPPING_CONFLICT' then 'Mapeamento de estoque em conflito'
        when 'STOCK_MAPPING_MISSING' then 'Mapeamento de estoque ausente'
      end)::text,
      format('Alerta operacional %s (%s), aberto desde %s.', a.alert_type, a.severity, to_char(a.first_seen_at, 'DD/MM')),
      jsonb_build_object('alertType', a.alert_type, 'severity', a.severity, 'suggestedActionCode', a.suggested_action_code, 'firstSeenAt', a.first_seen_at, 'evidence', a.evidence)
    from public.operational_alerts a
    where a.organization_id = target_organization_id
      and a.status = 'open'
      and a.alert_type in ('PHYSICAL_OUT_OF_STOCK', 'FULL_REPLENISH_FROM_PHYSICAL', 'PURCHASE_REPLENISHMENT_REQUIRED', 'PURCHASE_REPLENISHMENT_DUE', 'STOCK_MAPPING_CONFLICT', 'STOCK_MAPPING_MISSING')
  ),
  alert_candidates_deduped as (
    select distinct on (opportunity_type, product_id) *
    from alert_candidates
    order by opportunity_type, product_id, priority
  ),

  -- 8. GROWTH_LOW_COVERAGE
  growth_candidates (opportunity_type, product_id, ml_account_id, item_id, scope_type, priority, score, fingerprint, title, summary, evidence) as (
    select
      'GROWTH_LOW_COVERAGE', st.product_id, null::uuid, null::text, 'product',
      'medium',
      coalesce(st.units30 - st.previous_units30, 0),
      'GROWTH_LOW_COVERAGE:' || st.product_id,
      'Crescimento com cobertura baixa',
      format('Vendas cresceram de %s para %s unidades (30 dias); cobertura de %s dias e menor que o lead time de compra (%s dias).', st.previous_units30, st.units30, round(ps.coverage_days), ps.lead_time_days),
      jsonb_build_object('units30', st.units30, 'previousUnits30', st.previous_units30, 'coverageDays', ps.coverage_days, 'leadTimeDays', ps.lead_time_days)
    from sales_totals st
    join public.product_inventory_links pil on pil.organization_id = target_organization_id and pil.product_id = st.product_id and pil.is_active and pil.source = 'upseller'
    join planning_signals ps on ps.source_sku_key = pil.source_sku_key
    where st.previous_units30 >= 5 and st.units30 > st.previous_units30
      and (st.units30 - st.previous_units30) / nullif(st.previous_units30, 0) >= 0.3
      and ps.sales_velocity_ready
      and ps.coverage_days is not null and ps.coverage_days < ps.lead_time_days
      and ps.status not in ('urgent', 'due')
  ),

  -- 9. PROMOTION_ENDED_SALES_DROP (current-state approximation: no snapshot history needed)
  promotion_ended_candidates (opportunity_type, product_id, ml_account_id, item_id, scope_type, priority, score, fingerprint, title, summary, evidence) as (
    select distinct on (st.product_id)
      'PROMOTION_ENDED_SALES_DROP', st.product_id, null::uuid, null::text, 'product',
      'medium'::text,
      coalesce(st.previous_units7 - st.units7, 0),
      'PROMOTION_ENDED_SALES_DROP:' || st.product_id,
      'Queda apos fim de promocao'::text,
      format('Promocao encerrada em %s; vendas cairam de %s para %s unidades (7 dias) - correlacao, nao causa comprovada.', to_char(pps.promotion_ends_at, 'DD/MM'), st.previous_units7, st.units7),
      jsonb_build_object('promotionEndsAt', pps.promotion_ends_at, 'itemId', pps.item_id, 'units7', st.units7, 'previousUnits7', st.previous_units7)
    from sales_totals st
    join public.ml_listings l on l.organization_id = target_organization_id and l.product_id = st.product_id and l.is_current
    join public.ml_offer_price_states pps on pps.organization_id = target_organization_id and pps.ml_listing_id = l.id
    where st.previous_units7 >= 3 and st.units7 < st.previous_units7
      and (st.previous_units7 - st.units7) / nullif(st.previous_units7, 0) >= 0.3
      and pps.has_active_promotion = false
      and pps.promotion_ends_at is not null
      and pps.promotion_ends_at between (as_of_date - 7)::timestamptz and (as_of_date + 1)::timestamptz
    order by st.product_id, pps.promotion_ends_at desc
  ),

  -- 10. PRICE_NOT_COMPETITIVE (cache only — never fetches Mercado Livre during a scan)
  price_entries as (
    select fom.product_id, entry from fresh_official_market fom, jsonb_array_elements(fom.data -> 'priceToWin') as entry
  ),
  price_not_competitive_candidates (opportunity_type, product_id, ml_account_id, item_id, scope_type, priority, score, fingerprint, title, summary, evidence) as (
    select distinct on (pe.product_id, entry ->> 'accountCode', entry ->> 'itemId')
      'PRICE_NOT_COMPETITIVE', pe.product_id, acc.id, entry ->> 'itemId', 'listing'::text,
      'high'::text,
      coalesce((entry ->> 'currentPrice')::numeric - (entry ->> 'priceToWin')::numeric, 0),
      'PRICE_NOT_COMPETITIVE:' || pe.product_id || ':' || coalesce(acc.id::text, 'x') || ':' || (entry ->> 'itemId'),
      'Preco pouco competitivo'::text,
      format('Preco atual acima do price to win na conta %s.', entry ->> 'accountCode'),
      jsonb_build_object('currentPrice', (entry ->> 'currentPrice')::numeric, 'priceToWin', (entry ->> 'priceToWin')::numeric, 'status', entry ->> 'status', 'accountCode', entry ->> 'accountCode')
    from price_entries pe
    left join public.ml_accounts acc on acc.organization_id = target_organization_id and acc.code = entry ->> 'accountCode'
    where entry ->> 'status' in ('competing', 'listed')
      and entry ->> 'priceToWin' is not null and (entry ->> 'priceToWin')::numeric > 0
      and entry ->> 'currentPrice' is not null
      and (entry ->> 'priceToWin')::numeric < (entry ->> 'currentPrice')::numeric
  ),

  -- 11. LISTING_QUALITY (cache only)
  performance_entries as (
    select fom.product_id, entry from fresh_official_market fom, jsonb_array_elements(fom.data -> 'performance') as entry
  ),
  listing_quality_candidates (opportunity_type, product_id, ml_account_id, item_id, scope_type, priority, score, fingerprint, title, summary, evidence) as (
    select distinct on (pe.product_id, entry ->> 'accountCode', entry ->> 'itemId')
      'LISTING_QUALITY', pe.product_id, acc.id, entry ->> 'itemId', 'listing'::text,
      'medium'::text,
      coalesce(100 - (entry ->> 'score')::numeric, 0),
      'LISTING_QUALITY:' || pe.product_id || ':' || coalesce(acc.id::text, 'x') || ':' || (entry ->> 'itemId'),
      'Anuncio precisa melhorar'::text,
      format('Performance do anuncio: %s.', coalesce(entry ->> 'levelWording', entry ->> 'level', 'baixa')),
      jsonb_build_object('score', entry ->> 'score', 'level', entry ->> 'level', 'pendingBuckets', coalesce(entry -> 'pendingBuckets', '[]'::jsonb), 'accountCode', entry ->> 'accountCode')
    from performance_entries pe
    left join public.ml_accounts acc on acc.organization_id = target_organization_id and acc.code = entry ->> 'accountCode'
    where ((entry ->> 'score') is not null and (entry ->> 'score')::numeric < 60)
       or jsonb_array_length(coalesce(entry -> 'pendingBuckets', '[]'::jsonb)) > 0
  )

  select * from sales_drop_candidates
  union all select * from no_sales_candidates
  union all select * from account_specific_candidates
  union all select * from alert_candidates_deduped
  union all select * from growth_candidates
  union all select * from promotion_ended_candidates
  union all select * from price_not_competitive_candidates
  union all select * from listing_quality_candidates;

  with upserted as (
    insert into public.product_opportunities (
      organization_id, product_id, opportunity_type, ml_account_id, item_id, scope_type,
      priority, score, fingerprint, title, summary, evidence, evidence_hash,
      first_seen_at, last_seen_at, last_evaluated_at
    )
    select
      target_organization_id, c.product_id, c.opportunity_type, c.ml_account_id, c.item_id, c.scope_type,
      c.priority, c.score, c.fingerprint, c.title, c.summary, c.evidence, encode(sha256(c.evidence::text::bytea), 'hex'),
      now(), now(), now()
    from tmp_candidates c
    on conflict (organization_id, fingerprint) do update set
      ml_account_id = excluded.ml_account_id,
      item_id = excluded.item_id,
      priority = excluded.priority,
      score = excluded.score,
      title = excluded.title,
      summary = excluded.summary,
      evidence = excluded.evidence,
      evidence_hash = excluded.evidence_hash,
      last_seen_at = now(),
      last_evaluated_at = now(),
      status = case when product_opportunities.status = 'resolved' then 'open' else product_opportunities.status end,
      resolved_at = case when product_opportunities.status = 'resolved' then null else product_opportunities.resolved_at end,
      updated_at = now()
    where product_opportunities.status <> 'dismissed'
    returning (xmax = 0) as is_new
  )
  select count(*) filter (where is_new), count(*) filter (where not is_new)
  into opened_count, updated_count
  from upserted;

  with resolved as (
    update public.product_opportunities
    set status = 'resolved', resolved_at = now(), updated_at = now(), last_evaluated_at = now()
    where organization_id = target_organization_id
      and status in ('open', 'snoozed')
      and fingerprint not in (select fingerprint from tmp_candidates)
    returning 1
  )
  select count(*) into resolved_count from resolved;

  update public.product_opportunity_scan_runs
  set status = 'succeeded', phase = 'done', scanned_products = scanned_count, opened = coalesce(opened_count, 0),
      updated = coalesce(updated_count, 0), resolved = resolved_count, completed_at = now()
  where id = scan_id;

  return jsonb_build_object(
    'scanId', scan_id, 'scannedProducts', scanned_count, 'opened', coalesce(opened_count, 0),
    'updated', coalesce(updated_count, 0), 'resolved', resolved_count
  );
exception when others then
  update public.product_opportunity_scan_runs
  set status = 'failed', error_code = 'scan_failed', error_message = left(sqlerrm, 500), completed_at = now()
  where id = scan_id;
  raise;
end;
$function$;

grant execute on function public.scan_product_opportunities(uuid) to service_role;

create or replace function public.get_product_opportunities_summary(target_organization_id uuid)
 returns jsonb
 language plpgsql
 stable
 security invoker
 set search_path to ''
as $function$
declare
  caller_role text := coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '');
  result jsonb;
begin
  if not (private.is_organization_member(target_organization_id) or caller_role = 'service_role') then
    raise exception 'not_authorized';
  end if;

  select jsonb_build_object(
    'openTotal', count(*),
    'critical', count(*) filter (where priority = 'critical'),
    'high', count(*) filter (where priority = 'high'),
    'medium', count(*) filter (where priority = 'medium'),
    'low', count(*) filter (where priority = 'low'),
    'byType', coalesce((select jsonb_object_agg(opportunity_type, cnt) from (
      select opportunity_type, count(*) as cnt from public.product_opportunities
      where organization_id = target_organization_id and status = 'open'
      group by opportunity_type
    ) t), '{}'::jsonb)
  )
  into result
  from public.product_opportunities
  where organization_id = target_organization_id and status = 'open';

  return result;
end;
$function$;

grant execute on function public.get_product_opportunities_summary(uuid) to authenticated, service_role;

create or replace function public.get_product_opportunities_page(
  target_organization_id uuid,
  status_filter text default 'open',
  priority_filter text default null,
  type_filter text default null,
  account_filter uuid default null,
  search_text text default null,
  page_size integer default 25,
  page_cursor timestamptz default null,
  page_cursor_id uuid default null
)
 returns jsonb
 language plpgsql
 stable
 security invoker
 set search_path to ''
as $function$
declare
  caller_role text := coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '');
  effective_page_size integer := least(greatest(coalesce(page_size, 25), 1), 100);
  result jsonb;
begin
  if not (private.is_organization_member(target_organization_id) or caller_role = 'service_role') then
    raise exception 'not_authorized';
  end if;

  select coalesce(jsonb_agg(row_to_json(page)), '[]'::jsonb)
  into result
  from (
    select
      o.id, o.product_id, p.sku, p.sku_key, p.name as product_name, o.opportunity_type, o.ml_account_id,
      acc.code as account_code, acc.display_name as account_display_name, o.item_id, o.scope_type,
      o.status, o.priority, o.score, o.title, o.summary, o.evidence, o.primary_action_code, o.primary_action_text,
      o.latest_diagnostic_run_id, o.first_seen_at, o.last_seen_at, o.snoozed_until, o.dismissed_at
    from public.product_opportunities as o
    join public.products as p on p.organization_id = o.organization_id and p.id = o.product_id
    left join public.ml_accounts as acc on acc.id = o.ml_account_id
    where o.organization_id = target_organization_id
      and (status_filter is null or o.status = status_filter)
      and (priority_filter is null or o.priority = priority_filter)
      and (type_filter is null or o.opportunity_type = type_filter)
      and (account_filter is null or o.ml_account_id = account_filter)
      and (search_text is null or p.sku ilike '%' || search_text || '%' or p.name ilike '%' || search_text || '%' or o.item_id ilike '%' || search_text || '%')
      and (page_cursor is null or o.last_seen_at < page_cursor or (o.last_seen_at = page_cursor and o.id < page_cursor_id))
    order by
      (case o.priority when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end),
      o.score desc,
      o.last_seen_at desc,
      o.id desc
    limit effective_page_size
  ) as page;

  return result;
end;
$function$;

grant execute on function public.get_product_opportunities_page(uuid, text, text, text, uuid, text, integer, timestamptz, uuid) to authenticated, service_role;

-- Scan runs at most every 6 hours, DB-only (no ML/Anthropic calls), one
-- worker invocation per organization per tick — matches the "no concurrency"
-- precedent from reduce_alert_dispatch_concurrency.
create or replace function private.run_product_opportunity_scan_for_all_organizations()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  org record;
  scanned_orgs integer := 0;
begin
  for org in select id from public.organizations loop
    begin
      perform public.scan_product_opportunities(org.id);
      scanned_orgs := scanned_orgs + 1;
    exception when others then
      insert into public.product_opportunity_scan_runs (organization_id, status, phase, error_code, error_message, completed_at)
      values (org.id, 'failed', 'scanning', 'scan_dispatch_failed', left(sqlerrm, 500), now());
    end;
  end loop;
  return scanned_orgs;
end;
$function$;

select cron.schedule(
  'product-opportunity-scan-every-6-hours',
  '0 */6 * * *',
  $$select private.run_product_opportunity_scan_for_all_organizations();$$
);
