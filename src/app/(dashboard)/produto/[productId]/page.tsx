import {
  notFound,
  redirect,
} from "next/navigation";

import {
  ProductDashboardView,
} from "@/components/dashboard/product-dashboard-view";

import {
  getProductDashboard,
} from "@/features/dashboard/get-product-dashboard";

import {
  getProductListings,
} from "@/features/dashboard/get-product-listings";

import {
  getProductOfferHistory,
} from "@/features/dashboard/get-product-offer-history";

import {
  getProductStockIntelligence,
} from "@/features/stock/get-product-stock-intelligence";

import {
  getProductDiagnosticsAccess,
} from "@/features/auth/get-product-diagnostics-access";

import {
  getLatestProductDiagnostic,
} from "@/features/product-diagnostics/get-product-diagnostic-latest";

import {
  buildProductDiagnosticEvidenceForProduct,
} from "@/features/product-diagnostics/build-product-diagnostic-evidence";

import {
  PRODUCT_DIAGNOSTIC_PROMPT_VERSION_V2,
} from "@/features/product-diagnostics/product-diagnostic-prompt-v2";


type ProductDashboardPageProps = {
  params:
    Promise<{
      productId:
        string;
    }>;
};

const MARKET_CACHE_MIN_TTL_MS = 45 * 60 * 1000;

// V2's evidenceHash spans V1 + market + external + vision evidence, so it
// is never directly comparable to internalFactsHash (V1-only) — that
// comparison is only valid when the latest run IS a V1 run. Extracted as a
// plain helper (rather than an inline Date.now() in the component body) so
// it satisfies the react-hooks/purity lint rule, matching the same pattern
// used by isOverdue() in purchase-order-detail-view.tsx.
function computeIsDiagnosticStale(params: {
  latestDiagnostic: { promptVersion: string; evidenceHash: string; createdAt: string } | null;
  internalFactsHash: string | null;
  isV2Diagnostic: boolean;
}) {
  if (!params.latestDiagnostic) return false;
  if (params.isV2Diagnostic) {
    return Date.now() - new Date(params.latestDiagnostic.createdAt).getTime() > MARKET_CACHE_MIN_TTL_MS;
  }
  return params.internalFactsHash !== null && params.internalFactsHash !== params.latestDiagnostic.evidenceHash;
}


export default async function ProductDashboardPage({
  params,
}: ProductDashboardPageProps) {

  const {
    productId,
  } = await params;


  const dashboard =
    await getProductDashboard({
      productId,
    });


  if (!dashboard) {
    redirect(
      "/login",
    );
  }


  if (!dashboard.found) {
    notFound();
  }


  const [
    productListings,
    offerHistory,
    stockIntelligence,
    diagnosticsAccess,
    latestDiagnostic,
  ] =
    await Promise.all([

      getProductListings({
        productId,
      }),


      getProductOfferHistory({
        productId,

        limit:
          100,
      }),


      getProductStockIntelligence(
        productId,
        {
          organizationId:
            dashboard
              .access
              .organizationId,
          allowedMlAccountIds:
            dashboard
              .accounts
              .map(
                (account) =>
                  account.id,
              ),
        },
      ).catch(
        (
          error,
        ) => {
          console.error(
            "Product stock intelligence failed:",
            error,
          );

          return null;
        },
      ),

      getProductDiagnosticsAccess(),

      getLatestProductDiagnostic(productId),

    ]);

  // Cheap staleness signal — never calls Claude and never hits the live
  // Mercado Livre APIs at page load (those are only fetched on click, per
  // ETAPA 36's performance rule). It only rebuilds the V1-covered internal
  // evidence (same DB-only RPC V1 always ran at page load) to detect
  // whether sales/price/stock facts moved. A V2 diagnostic additionally
  // carries market data with its own 45min-12h TTLs that this check can't
  // cheaply verify without a live fetch, so V2 runs also fall back to a
  // time-based staleness signal (older than the shortest market TTL).
  const internalFactsHash = latestDiagnostic
    ? await buildProductDiagnosticEvidenceForProduct({
        organizationId: dashboard.access.organizationId,
        productId,
        allowedMlAccountIds: dashboard.accounts.map((account) => account.id),
      })
        .then((built) => built?.evidenceHash ?? null)
        .catch(() => null)
    : null;

  const isV2Diagnostic = latestDiagnostic?.promptVersion === PRODUCT_DIAGNOSTIC_PROMPT_VERSION_V2;
  const isDiagnosticStale = computeIsDiagnosticStale({ latestDiagnostic, internalFactsHash, isV2Diagnostic });

  return (
    <ProductDashboardView
      dashboard={
        dashboard
      }
      productListings={
        productListings
      }
      offerHistory={
        offerHistory
      }
      stockIntelligence={
        stockIntelligence
      }
      diagnosticsCanGenerate={diagnosticsAccess.canGenerate}
      latestDiagnostic={latestDiagnostic}
      isDiagnosticStale={
        isDiagnosticStale
      }
    />
  );
}
