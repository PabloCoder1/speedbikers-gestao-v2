import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import type { Evidence } from "@/features/product-diagnostics/product-diagnostic-domain";
import type { OpportunityPriority, OpportunityStatus, OpportunityType } from "@/features/opportunities/opportunity-domain";
import { measureServerOperation } from "@/lib/observability/measure-server-operation";
import { createClient } from "@/lib/supabase/server";

export type ProductOpportunityRow = {
  id: string;
  productId: string;
  sku: string;
  skuKey: string;
  productName: string | null;
  opportunityType: OpportunityType;
  mlAccountId: string | null;
  accountCode: string | null;
  accountDisplayName: string | null;
  itemId: string | null;
  scopeType: "product" | "account" | "listing";
  status: OpportunityStatus;
  priority: OpportunityPriority;
  score: number;
  title: string;
  summary: string;
  evidence: Record<string, unknown> | Evidence[];
  primaryActionCode: string | null;
  primaryActionText: string | null;
  latestDiagnosticRunId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  snoozedUntil: string | null;
  dismissedAt: string | null;
};

export async function getProductOpportunitiesPage(options: {
  status?: OpportunityStatus | null;
  priority?: OpportunityPriority | null;
  opportunityType?: OpportunityType | null;
  accountId?: string | null;
  search?: string | null;
  pageSize?: number;
  cursor?: { lastSeenAt: string; id: string } | null;
}): Promise<ProductOpportunityRow[] | null> {
  return measureServerOperation("get_product_opportunities_page", () => getProductOpportunitiesPageImpl(options));
}

async function getProductOpportunitiesPageImpl(options: {
  status?: OpportunityStatus | null;
  priority?: OpportunityPriority | null;
  opportunityType?: OpportunityType | null;
  accountId?: string | null;
  search?: string | null;
  pageSize?: number;
  cursor?: { lastSeenAt: string; id: string } | null;
}): Promise<ProductOpportunityRow[] | null> {
  const access = await getCurrentAccess();
  if (!access) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_product_opportunities_page", {
    target_organization_id: access.organizationId,
    status_filter: options.status ?? "open",
    priority_filter: options.priority ?? null,
    type_filter: options.opportunityType ?? null,
    account_filter: options.accountId ?? null,
    search_text: options.search ?? null,
    page_size: options.pageSize ?? 25,
    page_cursor: options.cursor?.lastSeenAt ?? null,
    page_cursor_id: options.cursor?.id ?? null,
  });
  if (error) throw new Error(`PRODUCT_OPPORTUNITIES_PAGE_FAILED:${error.message}`);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    productId: String(row.product_id),
    sku: String(row.sku),
    skuKey: String(row.sku_key),
    productName: (row.product_name as string | null) ?? null,
    opportunityType: row.opportunity_type as OpportunityType,
    mlAccountId: (row.ml_account_id as string | null) ?? null,
    accountCode: (row.account_code as string | null) ?? null,
    accountDisplayName: (row.account_display_name as string | null) ?? null,
    itemId: (row.item_id as string | null) ?? null,
    scopeType: row.scope_type as "product" | "account" | "listing",
    status: row.status as OpportunityStatus,
    priority: row.priority as OpportunityPriority,
    score: Number(row.score ?? 0),
    title: String(row.title),
    summary: String(row.summary),
    evidence: (row.evidence ?? {}) as Record<string, unknown>,
    primaryActionCode: (row.primary_action_code as string | null) ?? null,
    primaryActionText: (row.primary_action_text as string | null) ?? null,
    latestDiagnosticRunId: (row.latest_diagnostic_run_id as string | null) ?? null,
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    snoozedUntil: (row.snoozed_until as string | null) ?? null,
    dismissedAt: (row.dismissed_at as string | null) ?? null,
  }));
}
