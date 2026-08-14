-- ============================================================
-- Speed Bikers Gestão V2
-- Finalização da autoridade de preços e promoções do ML.
-- ============================================================

alter table public.ml_offer_price_states
  add column base_price_source text not null default 'not_checked',
  add column effective_price_source text not null default 'not_checked',
  add column promotion_match_method text not null default 'none',
  add column active_promotion_count integer not null default 0,
  add column standard_price_resolution text not null default 'not_checked',
  add column standard_price_id text,
  add column standard_price_last_updated timestamptz,
  add column sale_price_id text,
  add column sale_price_regular_amount numeric(18, 2),
  add column sale_price_reference_at timestamptz,
  add column sale_price_campaign_id text,
  add column sale_price_promotion_id text,
  add column sale_price_promotion_type text,
  add column sale_price_is_price_per_quantity boolean,
  add column winning_offer_id text,
  add column winning_offer_promotion_id text,
  add column winning_offer_type text,
  add column winning_offer_status text,
  add column winning_offer_error text,
  add column promotion_details_error text,
  add column price_checked_at timestamptz,
  add column prices_payload jsonb,
  add column sale_price_payload jsonb,
  add column promotions_payload jsonb,
  add column winning_offer_payload jsonb;

create unique index ml_offer_price_states_offer_identity_unique_idx
on public.ml_offer_price_states (
  ml_listing_id,
  offer_scope,
  ml_listing_variation_id
) nulls not distinct;

alter table public.ml_offer_price_states
  drop constraint if exists ml_offer_price_states_promotion_resolution_check,
  drop constraint if exists ml_offer_price_states_promotion_active_consistency_check,
  add constraint ml_offer_price_states_promotion_resolution_check check (
    promotion_resolution in (
      'not_checked', 'no_active_promotion', 'active_promotion',
      'active_promotion_without_price', 'ambiguous_multiple_active_prices',
      'sale_price_promotion_unmatched', 'started_promotion_not_winning'
    )
  ),
  add constraint ml_offer_price_states_promotion_active_consistency_check check (
    promotion_resolution = 'not_checked'
    or (promotion_resolution in ('no_active_promotion', 'started_promotion_not_winning') and has_active_promotion = false)
    or (promotion_resolution in ('active_promotion', 'active_promotion_without_price', 'ambiguous_multiple_active_prices', 'sale_price_promotion_unmatched') and has_active_promotion = true)
  ),
  add constraint ml_offer_price_states_base_price_source_check check (
    base_price_source in ('not_checked', 'prices_standard', 'sale_price_regular_fallback', 'sale_price_amount_fallback', 'legacy_listing_fallback', 'unresolved')
  ),
  add constraint ml_offer_price_states_effective_price_source_check check (
    effective_price_source in ('not_checked', 'sale_price', 'promotion_fallback', 'base_price_fallback', 'unresolved')
  ),
  add constraint ml_offer_price_states_promotion_match_method_check check (
    promotion_match_method in ('none', 'campaign_id', 'offer_lookup', 'promotion_ref_id', 'price_match', 'single_started')
  ),
  add constraint ml_offer_price_states_standard_price_resolution_check check (
    standard_price_resolution in ('not_checked', 'resolved', 'multiple_same_amount', 'ambiguous', 'not_found')
  ),
  add constraint ml_offer_price_states_active_promotion_count_check check (active_promotion_count >= 0),
  add constraint ml_offer_price_states_sale_regular_amount_check check (
    sale_price_regular_amount is null or sale_price_regular_amount >= 0
  );

create table public.ml_offer_price_state_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  ml_account_id uuid not null,
  ml_listing_id uuid not null,
  product_id uuid,
  item_id text not null,
  seller_sku text,
  currency_id text,
  base_price numeric(18, 2),
  effective_price numeric(18, 2),
  has_active_promotion boolean not null,
  promotion_resolution text not null,
  promotion_id text,
  promotion_type text,
  promotion_sub_type text,
  promotion_status text,
  promotion_name text,
  seller_percentage numeric,
  meli_percentage numeric,
  boosted_offer boolean,
  discount_meli_boosted_percentage numeric,
  discount_meli_boosted_amount numeric(18, 2),
  total_price_for_boosted_offer numeric(18, 2),
  promotion_started_at timestamptz,
  promotion_ends_at timestamptz,
  base_price_source text not null,
  effective_price_source text not null,
  promotion_match_method text not null,
  active_promotion_count integer not null,
  sale_price_campaign_id text,
  sale_price_promotion_id text,
  sale_price_promotion_type text,
  state_hash text not null check (char_length(state_hash) = 64),
  state_payload jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  source_sync_run_id uuid,
  constraint ml_offer_price_state_snapshots_listing_fk foreign key (
    organization_id, ml_account_id, ml_listing_id
  ) references public.ml_listings (organization_id, ml_account_id, id) on delete cascade,
  constraint ml_offer_price_state_snapshots_product_fk foreign key (
    organization_id, product_id
  ) references public.products (organization_id, id) on delete set null,
  constraint ml_offer_price_state_snapshots_sync_fk foreign key (source_sync_run_id)
    references public.sync_runs (id) on delete set null
);

create index ml_offer_price_state_snapshots_listing_idx
on public.ml_offer_price_state_snapshots (ml_listing_id, captured_at desc);

create index ml_offer_price_state_snapshots_product_idx
on public.ml_offer_price_state_snapshots (product_id, captured_at desc)
where product_id is not null;

alter table public.ml_offer_price_state_snapshots enable row level security;
revoke all on public.ml_offer_price_state_snapshots from anon;
revoke all on public.ml_offer_price_state_snapshots from authenticated;
grant select on public.ml_offer_price_state_snapshots to authenticated;

create policy "users can view permitted offer price history"
on public.ml_offer_price_state_snapshots for select to authenticated
using (private.can_access_ml_account(ml_account_id));

comment on table public.ml_offer_price_state_snapshots is
'Historical material changes of Mercado Livre public marketplace base/effective prices and winning promotion state.';
