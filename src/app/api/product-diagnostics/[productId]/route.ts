import { NextResponse } from "next/server";

import { getProductDiagnosticsAccess } from "@/features/auth/get-product-diagnostics-access";
import { getProductDashboard } from "@/features/dashboard/get-product-dashboard";
import { getAnthropicClient, isAnthropicConfigured, getProductDiagnosticModel } from "@/integrations/anthropic/client";
import { buildProductDiagnosticEvidenceForProduct } from "@/features/product-diagnostics/build-product-diagnostic-evidence";
import { PRODUCT_DIAGNOSTIC_EVIDENCE_VERSION, resolveDiagnosticCacheDecision } from "@/features/product-diagnostics/product-diagnostic-domain";
import { PRODUCT_DIAGNOSTIC_PROMPT_VERSION } from "@/features/product-diagnostics/product-diagnostic-prompt";
import { runProductDiagnostic } from "@/features/product-diagnostics/run-product-diagnostic";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RUN_SELECT_COLUMNS = "id,status,model,prompt_version,evidence_hash,evidence,result,error_code,error_message,created_at,completed_at";

type RunRow = {
  id: string;
  status: string;
  model: string;
  prompt_version: string;
  evidence_hash: string;
  evidence: unknown;
  result: unknown;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
};

function shapeRun(row: RunRow) {
  return {
    id: row.id,
    status: row.status,
    model: row.model,
    promptVersion: row.prompt_version,
    evidenceHash: row.evidence_hash,
    evidence: row.evidence,
    result: row.result,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export async function POST(request: Request, { params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;

  const { access, canGenerate, status: accessStatus } = await getProductDiagnosticsAccess();
  if (!access) return NextResponse.json({ error: "not_authenticated" }, { status: accessStatus });
  if (!canGenerate) return NextResponse.json({ error: "insufficient_role" }, { status: 403 });

  if (!isAnthropicConfigured()) {
    return NextResponse.json({ status: "anthropic_not_configured" }, { status: 200 });
  }

  const dashboard = await getProductDashboard({ productId });
  if (!dashboard || !dashboard.found) {
    return NextResponse.json({ error: "product_not_found" }, { status: 404 });
  }

  let force = false;
  try {
    const body = await request.json();
    force = body?.force === true;
  } catch {
    force = false;
  }

  const built = await buildProductDiagnosticEvidenceForProduct({
    organizationId: access.organizationId,
    productId,
    allowedMlAccountIds: dashboard.accounts.map((account) => account.id),
  });
  if (!built) return NextResponse.json({ error: "product_not_found" }, { status: 404 });

  const model = getProductDiagnosticModel();
  const admin = createAdminClient();

  const { data: cached, error: cacheError } = await admin
    .from("product_diagnostic_runs")
    .select(RUN_SELECT_COLUMNS)
    .eq("organization_id", access.organizationId)
    .eq("product_id", productId)
    .eq("evidence_hash", built.evidenceHash)
    .eq("prompt_version", PRODUCT_DIAGNOSTIC_PROMPT_VERSION)
    .eq("model", model)
    .eq("status", "succeeded")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<RunRow>();
  if (cacheError) return NextResponse.json({ error: "internal_error" }, { status: 500 });

  if (resolveDiagnosticCacheDecision({ hasCachedSuccess: Boolean(cached), force }) === "use_cache" && cached) {
    console.log(JSON.stringify({ event: "product_diagnostic_cache_hit", productId, model }));
    return NextResponse.json({ status: "succeeded", cached: true, run: shapeRun(cached) });
  }

  const { data: runningRow, error: insertError } = await admin
    .from("product_diagnostic_runs")
    .insert({
      organization_id: access.organizationId,
      product_id: productId,
      requested_by: access.userId,
      status: "running",
      diagnostic_trigger: "manual",
      evidence_version: PRODUCT_DIAGNOSTIC_EVIDENCE_VERSION,
      evidence_hash: built.evidenceHash,
      prompt_version: PRODUCT_DIAGNOSTIC_PROMPT_VERSION,
      model,
      evidence: built.evidence,
    })
    .select("id")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      return NextResponse.json({ status: "analysis_in_progress" }, { status: 409 });
    }
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  console.log(JSON.stringify({ event: "product_diagnostic_started", productId, model }));

  const outcome = await runProductDiagnostic({
    evidence: built.evidence,
    product: { sku: built.raw.product.sku, name: built.raw.product.name },
    asOfDate: built.raw.asOfDate,
    trigger: built.facts.sales.trigger,
    model,
    client: getAnthropicClient()?.messages,
  });

  if (outcome.ok) {
    const { data: updated, error: updateError } = await admin
      .from("product_diagnostic_runs")
      .update({
        status: "succeeded",
        result: outcome.result,
        anthropic_message_id: outcome.messageId,
        input_tokens: outcome.usage.inputTokens,
        output_tokens: outcome.usage.outputTokens,
        cache_creation_input_tokens: outcome.usage.cacheCreationInputTokens,
        cache_read_input_tokens: outcome.usage.cacheReadInputTokens,
        latency_ms: outcome.latencyMs,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runningRow.id)
      .select(RUN_SELECT_COLUMNS)
      .single<RunRow>();
    if (updateError || !updated) return NextResponse.json({ error: "internal_error" }, { status: 500 });

    console.log(JSON.stringify({ event: "product_diagnostic_succeeded", productId, model, latencyMs: outcome.latencyMs, inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens }));
    return NextResponse.json({ status: "succeeded", cached: false, run: shapeRun(updated) });
  }

  const { data: failedRow, error: failUpdateError } = await admin
    .from("product_diagnostic_runs")
    .update({
      status: "failed",
      error_code: outcome.errorCode,
      error_message: outcome.errorMessage,
      latency_ms: outcome.latencyMs,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runningRow.id)
    .select(RUN_SELECT_COLUMNS)
    .single<RunRow>();
  if (failUpdateError || !failedRow) return NextResponse.json({ error: "internal_error" }, { status: 500 });

  console.log(JSON.stringify({ event: "product_diagnostic_failed", productId, model, errorCode: outcome.errorCode, latencyMs: outcome.latencyMs }));
  return NextResponse.json({ status: "failed", run: shapeRun(failedRow) });
}
