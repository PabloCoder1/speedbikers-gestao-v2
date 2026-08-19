import "server-only";

import { getAnthropicClient, getProductDiagnosticModel } from "@/integrations/anthropic/client";
import { buildMarketResearchQuery } from "@/features/product-diagnostics/product-market-research-trigger";
import { runMarketResearch } from "@/features/product-diagnostics/run-market-research";
import type { ExternalMarketResult } from "@/features/product-diagnostics/product-market-evidence-domain";
import { createAdminClient } from "@/lib/supabase/admin";

const EXTERNAL_WEB_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

type CachedExternalMarketData = { externalResults: ExternalMarketResult[]; summary: string };

async function readCache(organizationId: string, productId: string): Promise<CachedExternalMarketData | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("product_market_research_runs")
    .select("data,expires_at")
    .eq("organization_id", organizationId)
    .eq("product_id", productId)
    .eq("kind", "external_web")
    .eq("status", "succeeded")
    .gt("expires_at", new Date().toISOString())
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`PRODUCT_DIAGNOSTIC_EXTERNAL_CACHE_READ_FAILED:${error.message}`);
  return (data?.data as CachedExternalMarketData | undefined) ?? null;
}

async function writeCache(organizationId: string, productId: string, outcome: { status: "succeeded"; data: CachedExternalMarketData } | { status: "failed"; errorCode: string; errorMessage: string }) {
  const admin = createAdminClient();
  const expiresAt = new Date(Date.now() + EXTERNAL_WEB_CACHE_TTL_MS).toISOString();
  await admin.from("product_market_research_runs").insert(
    outcome.status === "succeeded"
      ? { organization_id: organizationId, product_id: productId, kind: "external_web", status: "succeeded", data: outcome.data, expires_at: expiresAt }
      : { organization_id: organizationId, product_id: productId, kind: "external_web", status: "failed", data: {}, error_code: outcome.errorCode, error_message: outcome.errorMessage, expires_at: expiresAt },
  );
}

/** Cached 12h (product_market_research_runs, kind='external_web'). Returns null (not a failure) when web search isn't configured — the diagnostic still proceeds without external evidence. */
export async function fetchExternalMarketResearch(params: {
  organizationId: string;
  productId: string;
  product: { brand: string | null; partNumber: string | null; ean: string | null; sku: string; skuCommerciallySignificant: boolean; name: string; compatibility: string | null };
  forceRefresh: boolean;
}): Promise<CachedExternalMarketData | null> {
  if (!params.forceRefresh) {
    const cached = await readCache(params.organizationId, params.productId);
    if (cached) return cached;
  }

  const client = getAnthropicClient();
  if (!client) return null;

  const query = buildMarketResearchQuery({
    brand: params.product.brand,
    partNumber: params.product.partNumber,
    ean: params.product.ean,
    sku: params.product.sku,
    skuCommerciallySignificant: params.product.skuCommerciallySignificant,
    name: params.product.name,
    compatibility: params.product.compatibility,
  });

  const outcome = await runMarketResearch({ query, model: getProductDiagnosticModel(), client: client.messages });
  if (!outcome.ok) {
    await writeCache(params.organizationId, params.productId, { status: "failed", errorCode: outcome.errorCode, errorMessage: outcome.errorMessage });
    return null;
  }

  const data: CachedExternalMarketData = { externalResults: outcome.externalResults, summary: outcome.summary };
  await writeCache(params.organizationId, params.productId, { status: "succeeded", data });
  return data;
}
