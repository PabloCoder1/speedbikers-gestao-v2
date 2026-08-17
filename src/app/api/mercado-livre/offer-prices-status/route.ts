import { NextResponse } from "next/server";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { createAdminClient } from "@/lib/supabase/admin";

type AccountRow = { id: string; code: string };
type CoverageResult = {
  summary: Record<string, number | boolean>;
  accounts: { code: string }[];
  refreshJobs: Record<string, number>;
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

    /*
     * A cobertura é agregada no banco. Antes, esta rota carregava todos os
     * ml_listings atuais e todos os ml_offer_price_states em páginas de
     * 1.000 linhas só para produzir oito contagens: 10.286 linhas medidas
     * por chamada. A RPC devolve os mesmos números em ~1 KB.
     */
    const { data: coverageData, error: coverageError } = await admin.rpc(
      "get_offer_price_coverage",
      { target_organization_id: access.organizationId },
    );
    if (coverageError) throw new Error(coverageError.message);
    const coverage = coverageData as unknown as CoverageResult;

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

    return NextResponse.json({
      ok: true,
      summary: coverage.summary,
      accounts: coverage.accounts,
      backfills,
      refreshJobs: coverage.refreshJobs,
    });
  } catch (error) {
    console.error(
      "Mercado Livre offer prices status failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json({ error: "offer_prices_status_failed" }, { status: 500 });
  }
}
