import "server-only";

import { getAnthropicClient, getProductDiagnosticModel } from "@/integrations/anthropic/client";
import { runVisionAssessment } from "@/features/product-diagnostics/run-vision-assessment";
import type { OurListingImage, VisionAssessmentResult, CompetitorReferenceImage } from "@/features/product-diagnostics/product-diagnostic-vision";
import type { OfficialMarketData } from "@/features/product-diagnostics/fetch-official-market-data";
import { createAdminClient } from "@/lib/supabase/admin";

/** Not cached — bounded to at most 4 + 3 images already, and tied 1:1 to a single diagnostic run. Returns null when there are no images to assess (not a failure). */
export async function buildVisionAssessmentForProduct(params: {
  organizationId: string;
  productId: string;
  allowedMlAccountIds: string[];
  officialMarketData: OfficialMarketData | null;
}): Promise<VisionAssessmentResult | null> {
  const client = getAnthropicClient();
  if (!client) return null;

  const admin = createAdminClient();
  const { data: listings, error } = await admin
    .from("ml_listings")
    .select("ml_account_id,item_id,thumbnail,ml_accounts!inner(code)")
    .eq("organization_id", params.organizationId)
    .eq("product_id", params.productId)
    .eq("is_current", true)
    .in("ml_account_id", params.allowedMlAccountIds.length ? params.allowedMlAccountIds : ["00000000-0000-0000-0000-000000000000"])
    .not("thumbnail", "is", null);
  if (error) throw new Error(`PRODUCT_DIAGNOSTIC_VISION_LISTINGS_FAILED:${error.message}`);

  const ourImages: OurListingImage[] = (listings ?? [])
    .map((row) => {
      const account = Array.isArray(row.ml_accounts) ? row.ml_accounts[0] : row.ml_accounts;
      return { accountCode: (account as { code: string } | null)?.code ?? "unknown", itemId: row.item_id as string, imageUrl: row.thumbnail as string };
    })
    .slice(0, 4);
  if (ourImages.length === 0) return null;

  const referenceImages: CompetitorReferenceImage[] = Object.values(params.officialMarketData?.referenceThumbnailsByCatalogProduct ?? {})
    .flat()
    .slice(0, 3)
    .map((url) => ({ title: "Referencia de concorrente exato", imageUrl: url }));

  const outcome = await runVisionAssessment({ ourImages, referenceImages, model: getProductDiagnosticModel(), client: client.messages });
  if (!outcome.ok) {
    console.error(JSON.stringify({ event: "product_diagnostic_vision_failed", productId: params.productId, errorCode: outcome.errorCode }));
    return null;
  }
  return outcome.result;
}
