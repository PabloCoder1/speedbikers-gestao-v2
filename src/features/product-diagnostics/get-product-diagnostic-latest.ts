import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import type { Evidence } from "@/features/product-diagnostics/product-diagnostic-domain";
import type { ProductDiagnosticResult } from "@/features/product-diagnostics/product-diagnostic-schema";
import { measureServerOperation } from "@/lib/observability/measure-server-operation";
import { createClient } from "@/lib/supabase/server";

export type ProductDiagnosticRunRecord = {
  id: string;
  status: "succeeded" | "failed";
  model: string;
  promptVersion: string;
  evidenceHash: string;
  evidence: Evidence[];
  result: ProductDiagnosticResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
};

/** Cheap read for page load: no evidence rebuild, no Anthropic call — just the last persisted run. */
export async function getLatestProductDiagnostic(productId: string): Promise<ProductDiagnosticRunRecord | null> {
  return measureServerOperation("get_latest_product_diagnostic", () => getLatestImpl(productId));
}

async function getLatestImpl(productId: string): Promise<ProductDiagnosticRunRecord | null> {
  const access = await getCurrentAccess();
  if (!access) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("product_diagnostic_runs")
    .select("id,status,model,prompt_version,evidence_hash,evidence,result,error_code,error_message,created_at,completed_at")
    .eq("organization_id", access.organizationId)
    .eq("product_id", productId)
    .neq("status", "running")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`PRODUCT_DIAGNOSTIC_LATEST_LOOKUP_FAILED:${error.message}`);
  if (!data) return null;

  return {
    id: data.id,
    status: data.status as "succeeded" | "failed",
    model: data.model,
    promptVersion: data.prompt_version,
    evidenceHash: data.evidence_hash,
    evidence: (data.evidence as Evidence[] | null) ?? [],
    result: data.result as ProductDiagnosticResult | null,
    errorCode: data.error_code,
    errorMessage: data.error_message,
    createdAt: data.created_at,
    completedAt: data.completed_at,
  };
}
