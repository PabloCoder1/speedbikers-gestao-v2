import { NextResponse } from "next/server";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { createAdminClient } from "@/lib/supabase/admin";

const PAGE_SIZE = 1_000;
const UNCERTAIN_RESOLUTIONS = new Set([
  "sale_price_promotion_unmatched",
  "active_promotion_without_price",
  "ambiguous_multiple_active_prices",
]);

type AccountRow = { id: string; code: string };
type ListingRow = { id: string; ml_account_id: string };
type PriceStateRow = {
  ml_listing_id: string;
  base_price: number | string | null;
  effective_price: number | string | null;
  price_checked_at: string | null;
  has_active_promotion: boolean;
  promotion_resolution: string;
};
type BackfillRow = {
  ml_account_id: string;
  status: string;
  records_processed: number;
  records_discovered: number;
  records_upserted: number;
  retry_count: number;
  metadata: unknown;
};

function metadataObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function metadataNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function coverage(ready: number, total: number) {
  return total === 0 ? 0 : Math.round((ready / total) * 10_000) / 100;
}

async function loadPaged<T>(
  load: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
) {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await load(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

export async function GET() {
  const access = await getCurrentAccess();
  if (!access) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  if (access.role !== "admin") {
    return NextResponse.json({ error: "not_authorized" }, { status: 403 });
  }

  try {
    const admin = createAdminClient();
    const { data: accountData, error: accountError } = await admin
      .from("ml_accounts")
      .select("id,code")
      .eq("organization_id", access.organizationId)
      .eq("is_active", true)
      .returns<AccountRow[]>();
    if (accountError) throw new Error(accountError.message);
    const accountRows = accountData ?? [];
    const accountIds = new Set(accountRows.map((account) => account.id));

    const listings = await loadPaged<ListingRow>((from, to) =>
      admin
        .from("ml_listings")
        .select("id,ml_account_id")
        .eq("organization_id", access.organizationId)
        .eq("is_current", true)
        .order("id", { ascending: true })
        .range(from, to)
        .returns<ListingRow[]>(),
    );
    const currentListingIds = new Set(listings.map((listing) => listing.id));

    const states = await loadPaged<PriceStateRow>((from, to) =>
      admin
        .from("ml_offer_price_states")
        .select(
          "ml_listing_id,base_price,effective_price,price_checked_at,has_active_promotion,promotion_resolution",
        )
        .eq("organization_id", access.organizationId)
        .eq("offer_scope", "listing")
        .order("ml_listing_id", { ascending: true })
        .range(from, to)
        .returns<PriceStateRow[]>(),
    );
    const currentStates = states.filter((state) => currentListingIds.has(state.ml_listing_id));
    const readyListingIds = new Set(
      currentStates
        .filter(
          (state) =>
            state.base_price !== null &&
            state.effective_price !== null &&
            state.price_checked_at !== null,
        )
        .map((state) => state.ml_listing_id),
    );

    const accounts = accountRows.map((account) => {
      const accountListings = listings.filter(
        (listing) => listing.ml_account_id === account.id,
      );
      const priceReady = accountListings.filter((listing) =>
        readyListingIds.has(listing.id),
      ).length;
      return {
        code: account.code,
        currentListings: accountListings.length,
        priceReady,
        missingPrice: accountListings.length - priceReady,
        coveragePercent: coverage(priceReady, accountListings.length),
      };
    });

    const currentListings = listings.length;
    const priceReady = readyListingIds.size;
    const missingPrice = currentListings - priceReady;
    const activePromotions = currentStates.filter(
      (state) => state.has_active_promotion,
    ).length;
    const priceExplanationUncertain = currentStates.filter((state) =>
      UNCERTAIN_RESOLUTIONS.has(state.promotion_resolution),
    ).length;

    const { data: backfillData, error: backfillError } = await admin
      .from("sync_runs")
      .select(
        "ml_account_id,status,records_processed,records_discovered,records_upserted,retry_count,metadata,started_at",
      )
      .eq("organization_id", access.organizationId)
      .eq("sync_type", "offer_prices_backfill")
      .order("started_at", { ascending: false })
      .limit(20)
      .returns<BackfillRow[]>();
    if (backfillError) throw new Error(backfillError.message);
    const codeById = new Map(accountRows.map((account) => [account.id, account.code]));
    const backfills = (backfillData ?? [])
      .filter((run) => accountIds.has(run.ml_account_id))
      .map((run) => {
        const metadata = metadataObject(run.metadata);
        return {
          accountCode: codeById.get(run.ml_account_id) ?? "unknown",
          mode: metadata.mode === "reconcile" ? "reconcile" : "offer_prices_backfill",
          status: run.status,
          processed: run.records_processed,
          total: run.records_discovered,
          upserted: run.records_upserted,
          failures: metadataNumber(metadata.failure_count),
          retryCount: run.retry_count,
        };
      });

    const refreshStatuses = ["queued", "running", "succeeded", "failed", "ignored"] as const;
    const refreshCounts = await Promise.all(
      refreshStatuses.map(async (status) => {
        const { count, error } = await admin
          .from("ml_offer_refresh_jobs")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", access.organizationId)
          .eq("status", status);
        if (error) throw new Error(error.message);
        return [status, count ?? 0] as const;
      }),
    );

    return NextResponse.json({
      ok: true,
      summary: {
        currentListings,
        priceReady,
        missingPrice,
        coveragePercent: coverage(priceReady, currentListings),
        activePromotions,
        priceExplanationUncertain,
        readyForVisualSwitch: currentListings > 0 && missingPrice === 0,
      },
      accounts,
      backfills,
      refreshJobs: Object.fromEntries(refreshCounts),
    });
  } catch (error) {
    console.error(
      "Mercado Livre offer prices status failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json({ error: "offer_prices_status_failed" }, { status: 500 });
  }
}
