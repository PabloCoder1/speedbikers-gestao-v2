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


type ProductDashboardPageProps = {
  params:
    Promise<{
      productId:
        string;
    }>;
};


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

  // A hash comparison never calls Claude — it only rebuilds the same
  // deterministic evidence the POST route would rebuild, so staleness can
  // be shown on page load without spending any Anthropic cost.
  const currentEvidenceHash = latestDiagnostic
    ? await buildProductDiagnosticEvidenceForProduct({
        organizationId: dashboard.access.organizationId,
        productId,
        allowedMlAccountIds: dashboard.accounts.map((account) => account.id),
      })
        .then((built) => built?.evidenceHash ?? null)
        .catch(() => null)
    : null;

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
        latestDiagnostic
          ? currentEvidenceHash !== null && currentEvidenceHash !== latestDiagnostic.evidenceHash
          : false
      }
    />
  );
}
