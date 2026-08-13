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
  ] =
    await Promise.all([
      getProductDashboard({
        productId,
      }),

      getProductListings({
        productId,
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
    />
  );
}
