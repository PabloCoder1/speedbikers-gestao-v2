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


  const [
    dashboard,
    productListings,
    offerHistory,
  ] =
    await Promise.all([

      getProductDashboard({
        productId,
      }),


      getProductListings({
        productId,
      }),


      getProductOfferHistory({
        productId,

        limit:
          100,
      }),

    ]);


  if (!dashboard) {
    redirect(
      "/login",
    );
  }


  if (!dashboard.found) {
    notFound();
  }


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
    />
  );
}
