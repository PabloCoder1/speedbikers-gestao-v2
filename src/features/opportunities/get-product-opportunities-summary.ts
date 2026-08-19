import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import type { OpportunityType } from "@/features/opportunities/opportunity-domain";
import { measureServerOperation } from "@/lib/observability/measure-server-operation";
import { createClient } from "@/lib/supabase/server";

export type ProductOpportunitiesSummary = {
  openTotal: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  byType: Partial<Record<OpportunityType, number>>;
};

export async function getProductOpportunitiesSummary(): Promise<ProductOpportunitiesSummary | null> {
  return measureServerOperation("get_product_opportunities_summary", getProductOpportunitiesSummaryImpl);
}

async function getProductOpportunitiesSummaryImpl(): Promise<ProductOpportunitiesSummary | null> {
  const access = await getCurrentAccess();
  if (!access) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_product_opportunities_summary", { target_organization_id: access.organizationId });
  if (error) throw new Error(`PRODUCT_OPPORTUNITIES_SUMMARY_FAILED:${error.message}`);

  const result = (data ?? {}) as Record<string, unknown>;
  return {
    openTotal: Number(result.openTotal ?? 0),
    critical: Number(result.critical ?? 0),
    high: Number(result.high ?? 0),
    medium: Number(result.medium ?? 0),
    low: Number(result.low ?? 0),
    byType: (result.byType ?? {}) as Partial<Record<OpportunityType, number>>,
  };
}
