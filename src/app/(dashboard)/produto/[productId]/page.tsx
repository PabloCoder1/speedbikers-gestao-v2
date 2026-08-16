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

    ]);


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
    />
  );
}
