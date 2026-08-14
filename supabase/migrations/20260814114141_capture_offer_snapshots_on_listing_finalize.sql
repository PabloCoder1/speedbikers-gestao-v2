-- ============================================================
-- Speed Bikers Gestão V2
--
-- Make offer snapshot capture part of the atomic
-- finalization of a full listings sync run.
--
-- Before this migration, finalize_listings_sync_run() only
-- reconciled is_current on ml_listings / ml_listing_variations
-- and marked the run as 'succeeded'. Historical snapshots were
-- captured separately by the worker, outside this transaction.
--
-- That meant a run could be marked 'succeeded' even when the
-- historical capture step failed or was skipped.
--
-- Now:
--   reconciliation + snapshot capture + finalization
-- happen inside the SAME transaction. If snapshot capture
-- fails, the whole function fails and the run is NOT falsely
-- marked as succeeded.
-- ============================================================


create or replace function public.finalize_listings_sync_run(
  target_sync_run_id uuid,
  requested_lease_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_organization_id uuid;
  target_ml_account_id uuid;
  captured_snapshots integer;
begin


  -- ==========================================================
  -- 1. LOCK & VALIDATE SYNC RUN
  -- ==========================================================

  select
    sync_run.organization_id,
    sync_run.ml_account_id

  into
    target_organization_id,
    target_ml_account_id

  from public.sync_runs as sync_run

  where sync_run.id =
    target_sync_run_id

    and sync_run.sync_type =
      'listings_full'

    and sync_run.status =
      'running'

    and sync_run.lease_id =
      requested_lease_id

  for update;

  if target_ml_account_id is null then
    return false;
  end if;


  -- ==========================================================
  -- 2. RECONCILE LISTINGS
  --
  -- Listings not seen during this complete run are no longer
  -- considered part of the current seller inventory.
  -- ==========================================================

  update public.ml_listings

  set is_current =
    (
      last_seen_sync_run_id =
        target_sync_run_id
    )

  where organization_id =
      target_organization_id

    and ml_account_id =
      target_ml_account_id;


  -- ==========================================================
  -- 3. RECONCILE VARIATIONS
  -- ==========================================================

  update public.ml_listing_variations

  set is_current =
    (
      last_seen_sync_run_id =
        target_sync_run_id
    )

  where organization_id =
      target_organization_id

    and ml_account_id =
      target_ml_account_id;


  -- ==========================================================
  -- 4. CAPTURE OFFER SNAPSHOTS
  --
  -- Historical capture for every listing touched by this run,
  -- inside the same transaction as the reconciliation above.
  --
  -- If this fails, the exception propagates, the whole
  -- function fails, and the run is NOT marked 'succeeded'.
  -- ==========================================================

  select
    public.capture_ml_offer_state_snapshots(
      array(
        select
          listing.id

        from
          public.ml_listings
            as listing

        where
          listing.organization_id =
            target_organization_id

          and
          listing.ml_account_id =
            target_ml_account_id

          and
          listing.last_seen_sync_run_id =
            target_sync_run_id
      ),

      target_sync_run_id
    )

  into
    captured_snapshots;


  -- ==========================================================
  -- 5. FINALIZE SYNC RUN
  -- ==========================================================

  update public.sync_runs

  set
    status =
      'succeeded',

    lease_id = null,

    lease_expires_at = null,

    next_attempt_at =
      now(),

    metadata =
      coalesce(
        metadata,
        '{}'::jsonb
      )
      || jsonb_build_object(
        'captured_offer_snapshots',
        captured_snapshots
      ),

    finished_at =
      now()

  where
    id =
      target_sync_run_id;


  -- ==========================================================
  -- 6. ACCOUNT LAST SYNC
  -- ==========================================================

  update
    public.ml_accounts

  set
    last_synced_at =
      now()

  where
    id =
      target_ml_account_id

    and
    organization_id =
      target_organization_id;


  return true;


end;


$$;


-- ============================================================
-- SECURITY
-- ============================================================


revoke all
on function
public.finalize_listings_sync_run(
  uuid,
  uuid
)
from public;


revoke all
on function
public.finalize_listings_sync_run(
  uuid,
  uuid
)
from anon;


revoke all
on function
public.finalize_listings_sync_run(
  uuid,
  uuid
)
from authenticated;


grant execute
on function
public.finalize_listings_sync_run(
  uuid,
  uuid
)
to service_role;
