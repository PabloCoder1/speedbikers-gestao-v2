-- ============================================================
-- Speed Bikers Gestao V2
--
-- Stabilize price resolution when seller-promotions is not
-- applicable to the current Mercado Livre item status.
-- ============================================================


-- ============================================================
-- 1. PROMOTION FETCH OBSERVABILITY
-- ============================================================

alter table
public.ml_offer_price_states

add column
promotions_fetch_status text not null
default 'not_checked',

add column
promotions_fetch_error text,

add constraint
ml_offer_price_states_promotions_fetch_status_check
check (
  promotions_fetch_status in (
    'not_checked',
    'available',
    'not_applicable'
  )
);


-- ============================================================
-- 2. ONE ACTIVE MANUAL REPAIR PER LISTING
-- ============================================================

create unique index
ml_offer_refresh_jobs_one_active_manual_listing_idx

on public.ml_offer_refresh_jobs (
  ml_listing_id
)

where
  reason =
    'manual'

  and status in (
    'queued',
    'running'
  );


-- ============================================================
-- 3. ONE-TIME REPAIR SEED FOR SKIPPED BACKFILL ITEMS
--
-- Invalid metadata is ignored. A repair is created only when
-- both identifiers still match a current listing belonging to
-- the same organization and account as the original run.
-- ============================================================

with failed_items as (
  select
    sync_run.organization_id,
    sync_run.ml_account_id,
    failed_item.value

  from
    public.sync_runs
      as sync_run

  cross join lateral
    jsonb_array_elements(
      case
        when jsonb_typeof(
          sync_run.metadata ->
            'failed_items'
        ) = 'array'
        then
          sync_run.metadata ->
            'failed_items'
        else
          '[]'::jsonb
      end
    )
      as failed_item(value)

  where
    sync_run.sync_type =
      'offer_prices_backfill'

    and jsonb_typeof(
      failed_item.value
    ) = 'object'
),

repair_candidates as (
  select distinct
    failed_item.organization_id,
    failed_item.ml_account_id,
    listing.id
      as ml_listing_id,
    listing.item_id

  from
    failed_items
      as failed_item

  inner join
    public.ml_listings
      as listing

    on listing.organization_id =
      failed_item.organization_id

    and listing.ml_account_id =
      failed_item.ml_account_id

    and listing.id::text =
      failed_item.value ->>
        'listingId'

    and listing.item_id =
      failed_item.value ->>
        'itemId'

    and listing.is_current =
      true
)

insert into
public.ml_offer_refresh_jobs (
  organization_id,
  ml_account_id,
  ml_listing_id,
  item_id,
  reason,
  topic,
  status,
  attempt_count,
  max_attempts,
  next_attempt_at
)

select
  repair_candidate.organization_id,
  repair_candidate.ml_account_id,
  repair_candidate.ml_listing_id,
  repair_candidate.item_id,
  'manual',
  null,
  'queued',
  0,
  5,
  now()

from
  repair_candidates
    as repair_candidate

on conflict
do nothing;
