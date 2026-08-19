import "server-only";

import { buildProductDiagnosticEvidenceForProduct } from "@/features/product-diagnostics/build-product-diagnostic-evidence";
import { computeEvidenceHash, type Evidence } from "@/features/product-diagnostics/product-diagnostic-domain";
import { buildExternalMarketEvidence, buildOfficialMarketEvidence } from "@/features/product-diagnostics/product-market-evidence-domain";
import { buildVisionEvidence } from "@/features/product-diagnostics/product-diagnostic-vision";
import { fetchOfficialMarketData } from "@/features/product-diagnostics/fetch-official-market-data";
import { fetchExternalMarketResearch } from "@/features/product-diagnostics/fetch-external-market-research";
import { buildVisionAssessmentForProduct } from "@/features/product-diagnostics/fetch-vision-assessment-for-product";
import { shouldTriggerExternalMarketResearch } from "@/features/product-diagnostics/product-market-research-trigger";

/**
 * V2 evidence = V1 evidence (unchanged, reused as-is) + official ML
 * competitive data + (conditionally) external web research + vision
 * assessment. The combined evidenceHash is what product_diagnostic_jobs
 * caches against, so any market/vision change makes an old V2 diagnostic
 * stale even if the V1-covered facts didn't move.
 */
export async function buildProductDiagnosticEvidenceV2ForProduct(params: {
  organizationId: string;
  productId: string;
  allowedMlAccountIds: string[];
  forceMarketRefresh: boolean;
  userRequestedMarketResearch: boolean;
}) {
  const v1 = await buildProductDiagnosticEvidenceForProduct({
    organizationId: params.organizationId,
    productId: params.productId,
    allowedMlAccountIds: params.allowedMlAccountIds,
  });
  if (!v1) return null;

  const averageCost = typeof v1.stockIntelligence.physical.effectiveCost === "number" ? v1.stockIntelligence.physical.effectiveCost : null;

  const officialMarketData = await fetchOfficialMarketData({
    organizationId: params.organizationId,
    productId: params.productId,
    allowedMlAccountIds: params.allowedMlAccountIds,
    averageCost,
    forceRefresh: params.forceMarketRefresh,
  });

  const officialEvidence: Evidence[] = officialMarketData
    ? buildOfficialMarketEvidence({
        priceToWin: officialMarketData.priceToWin,
        competitorStatsByCatalogProduct: new Map(Object.entries(officialMarketData.competitorStatsByCatalogProduct)),
        priceSuggestions: officialMarketData.priceSuggestions,
        performance: officialMarketData.performance,
        knownContributionByItemId: new Map(Object.entries(officialMarketData.knownContributionByItemId)),
      })
    : [];

  const hasCatalogProductId = Boolean(officialMarketData && Object.values(officialMarketData.catalogProductIdByItemId).some(Boolean));
  const hasPriceReference = officialMarketData ? officialMarketData.priceSuggestions.some((entry) => entry.applicableSuggestion) : false;
  const internalAndOfficialDataExplainDrop = v1.facts.sales.trigger !== "SALES_DROP_7D" && v1.facts.sales.trigger !== "SALES_DROP_30D" && v1.facts.sales.trigger !== "NO_SALES_7D";

  let externalEvidence: Evidence[] = [];
  if (
    shouldTriggerExternalMarketResearch({
      hasCatalogProductId,
      hasPriceReference,
      internalAndOfficialDataExplainDrop,
      userRequestedMarketResearch: params.userRequestedMarketResearch,
    })
  ) {
    const externalData = await fetchExternalMarketResearch({
      organizationId: params.organizationId,
      productId: params.productId,
      product: {
        brand: v1.stockIntelligence.planning.brand,
        partNumber: null,
        ean: null,
        sku: v1.raw.product.sku,
        skuCommerciallySignificant: false,
        name: v1.raw.product.name,
        compatibility: null,
      },
      forceRefresh: params.forceMarketRefresh,
    });
    if (externalData) externalEvidence = buildExternalMarketEvidence(externalData.externalResults);
  }

  const visionResult = await buildVisionAssessmentForProduct({
    organizationId: params.organizationId,
    productId: params.productId,
    allowedMlAccountIds: params.allowedMlAccountIds,
    officialMarketData,
  });
  const visionEvidence = visionResult ? buildVisionEvidence(visionResult) : [];

  const evidence = [...v1.evidence, ...officialEvidence, ...externalEvidence, ...visionEvidence];
  const evidenceHash = computeEvidenceHash(evidence);

  return { evidence, evidenceHash, facts: v1.facts, raw: v1.raw };
}
