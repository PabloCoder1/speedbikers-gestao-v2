-- ============================================================
-- COBERTURA DE PREÇOS AGREGADA NO BANCO
-- ============================================================
--
-- Problema corrigido:
--
-- /api/mercado-livre/offer-prices-status carregava TODOS os ml_listings
-- atuais e TODOS os ml_offer_price_states da organização, em páginas de
-- 1.000 linhas, para depois produzir cerca de oito contagens com filter()
-- e Set() em JavaScript (route.ts:83-146). Medido em 17/08/2026: 5.146
-- anúncios e 5.143 estados de preço trafegados por chamada.
--
-- Esta função faz as mesmas contagens em SQL e devolve resumo global mais
-- quebra por conta em um único JSON.
--
-- Definições preservadas exatamente como estavam em JavaScript:
--   priceReady  = base_price, effective_price e price_checked_at não nulos
--   incerto     = promotion_resolution em três valores específicos
--   n/a         = promotions_fetch_status = 'not_applicable'
-- Só entram estados com offer_scope = 'listing' de anúncios is_current.
--
-- security definer porque a rota já autentica e exige papel admin antes
-- de chamar, e o cliente usado é o privilegiado.

create or replace function public.get_offer_price_coverage(
  target_organization_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with current_listing as (
    select listing.id, listing.ml_account_id
    from public.ml_listings as listing
    where listing.organization_id = target_organization_id
      and listing.is_current = true
  ),

  listing_state as (
    select
      current_listing.id,
      current_listing.ml_account_id,
      (
        state.base_price is not null
        and state.effective_price is not null
        and state.price_checked_at is not null
      ) as price_ready,
      coalesce(state.has_active_promotion, false) as has_active_promotion,
      state.promotion_resolution,
      state.promotions_fetch_status
    from current_listing
    left join public.ml_offer_price_states as state
      on state.organization_id = target_organization_id
     and state.offer_scope = 'listing'
     and state.ml_listing_id = current_listing.id
  ),

  totals as (
    select
      count(*)::bigint as current_listings,
      count(*) filter (where price_ready)::bigint as price_ready,
      count(*) filter (where has_active_promotion)::bigint as active_promotions,
      count(*) filter (
        where promotion_resolution in (
          'sale_price_promotion_unmatched',
          'active_promotion_without_price',
          'ambiguous_multiple_active_prices'
        )
      )::bigint as price_explanation_uncertain,
      count(*) filter (
        where promotions_fetch_status = 'not_applicable'
      )::bigint as promotion_data_not_applicable
    from listing_state
  ),

  per_account as (
    select
      account.code,
      count(listing_state.id)::bigint as current_listings,
      count(listing_state.id) filter (where listing_state.price_ready)::bigint as price_ready
    from public.ml_accounts as account
    left join listing_state
      on listing_state.ml_account_id = account.id
    where account.organization_id = target_organization_id
      and account.is_active = true
    group by account.code
  ),

  refresh_jobs as (
    select
      count(*) filter (where status = 'queued')::bigint as queued,
      count(*) filter (where status = 'running')::bigint as running,
      count(*) filter (where status = 'succeeded')::bigint as succeeded,
      count(*) filter (where status = 'failed')::bigint as failed,
      count(*) filter (where status = 'ignored')::bigint as ignored
    from public.ml_offer_refresh_jobs
    where organization_id = target_organization_id
  )

  select jsonb_build_object(
    'summary', (
      select jsonb_build_object(
        'currentListings', totals.current_listings,
        'priceReady', totals.price_ready,
        'missingPrice', totals.current_listings - totals.price_ready,
        'coveragePercent', case
          when totals.current_listings = 0 then 0
          else round(
            (totals.price_ready::numeric / totals.current_listings) * 100,
            2
          )
        end,
        'activePromotions', totals.active_promotions,
        'priceExplanationUncertain', totals.price_explanation_uncertain,
        'promotionDataNotApplicable', totals.promotion_data_not_applicable,
        'readyForVisualSwitch',
          totals.current_listings > 0
          and totals.current_listings = totals.price_ready
      )
      from totals
    ),
    'accounts', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'code', per_account.code,
          'currentListings', per_account.current_listings,
          'priceReady', per_account.price_ready,
          'missingPrice', per_account.current_listings - per_account.price_ready,
          'coveragePercent', case
            when per_account.current_listings = 0 then 0
            else round(
              (per_account.price_ready::numeric / per_account.current_listings) * 100,
              2
            )
          end
        )
        order by per_account.code
      )
      from per_account
    ), '[]'::jsonb),
    'refreshJobs', (
      select jsonb_build_object(
        'queued', refresh_jobs.queued,
        'running', refresh_jobs.running,
        'succeeded', refresh_jobs.succeeded,
        'failed', refresh_jobs.failed,
        'ignored', refresh_jobs.ignored
      )
      from refresh_jobs
    )
  );
$$;

revoke all on function public.get_offer_price_coverage(uuid)
from public, anon, authenticated;
