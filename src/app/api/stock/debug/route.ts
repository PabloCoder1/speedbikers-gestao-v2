import { NextResponse } from "next/server";

import { getAdminApiAccess } from "@/features/auth/get-admin-api-access";
import { getProductStockIntelligence } from "@/features/stock/get-product-stock-intelligence";
import { normalizeSku } from "@/features/stock/stock-domain";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authorization = await getAdminApiAccess();
  if (!authorization.access) return NextResponse.json({ error: "not_authorized" }, { status: authorization.status });
  const sku = new URL(request.url).searchParams.get("sku")?.trim();
  if (!sku || sku.length > 120) return NextResponse.json({ error: "invalid_sku" }, { status: 400 });
  const organizationId = authorization.access.organizationId;
  const skuKey = normalizeSku(sku);
  const admin = createAdminClient();
  const { data: product, error: productError } = await admin.from("products")
    .select("id,sku,sku_key,name,created_at,updated_at")
    .eq("organization_id", organizationId).eq("sku_key", skuKey).maybeSingle();
  if (productError) return NextResponse.json({ error: "product_lookup_failed" }, { status: 500 });
  if (!product) return NextResponse.json({ error: "product_not_found", sku, skuKey }, { status: 404 });

  const [catalog, stock, relationships, links, conflicts, kit, components, productListings, variations, alerts, intelligence] = await Promise.all([
    admin.from("upseller_product_catalog").select("*").eq("organization_id", organizationId).eq("sku_key", skuKey).maybeSingle(),
    admin.from("upseller_stock_states").select("*").eq("organization_id", organizationId).eq("sku_key", skuKey).order("warehouse_key"),
    admin.from("upseller_channel_sku_relationships").select("id,source_sku,source_sku_key,mapped_listing_sku,mapped_listing_sku_key,variant_label,listing_external_id,variant_external_id,store_name,store_name_key,channel,ml_account_id,source_updated_at_raw,is_current,source_import_id,raw_payload")
      .eq("organization_id", organizationId).eq("source_sku_key", skuKey).eq("is_current", true),
    admin.from("product_inventory_links").select("*").eq("organization_id", organizationId).eq("product_id", product.id).eq("is_active", true),
    admin.from("product_inventory_link_conflicts").select("*").eq("organization_id", organizationId).eq("product_id", product.id).eq("is_current", true),
    admin.from("upseller_kits").select("*").eq("organization_id", organizationId).eq("kit_sku_key", skuKey).eq("is_current", true).maybeSingle(),
    admin.from("upseller_kit_components").select("*").eq("organization_id", organizationId).eq("kit_sku_key", skuKey).eq("is_current", true),
    admin.from("ml_listings").select("id,ml_account_id,product_id,item_id,user_product_id,inventory_id,title,seller_sku,status,available_quantity,is_current,ml_last_updated")
      .eq("organization_id", organizationId).eq("product_id", product.id).eq("is_current", true),
    admin.from("ml_listing_variations").select("id,ml_account_id,ml_listing_id,product_id,variation_id,seller_sku,user_product_id,inventory_id,available_quantity,is_current")
      .eq("organization_id", organizationId).eq("product_id", product.id).eq("is_current", true),
    admin.from("operational_alerts").select("*").eq("organization_id", organizationId).eq("product_id", product.id).order("created_at", { ascending: false }),
    getProductStockIntelligence(product.id),
  ]);
  const relationshipItemIds = [...new Set((relationships.data ?? [])
    .map((row) => row.listing_external_id)
    .filter((value): value is string => typeof value === "string" && /^MLB[0-9]+$/.test(value)))];
  const relatedListings = relationshipItemIds.length
    ? await admin.from("ml_listings").select("id,ml_account_id,product_id,item_id,user_product_id,inventory_id,title,seller_sku,status,available_quantity,is_current,ml_last_updated")
        .eq("organization_id", organizationId).eq("is_current", true).in("item_id", relationshipItemIds)
    : { data: [], error: null };
  const allListings = [...new Map([...(productListings.data ?? []), ...(relatedListings.data ?? [])]
    .map((row) => [row.id, row])).values()];
  const relatedListingIds = allListings.map((row) => row.id);
  const relatedVariations = relatedListingIds.length
    ? await admin.from("ml_listing_variations").select("id,ml_account_id,ml_listing_id,product_id,variation_id,seller_sku,user_product_id,inventory_id,available_quantity,is_current")
        .eq("organization_id", organizationId).eq("is_current", true).in("ml_listing_id", relatedListingIds)
    : { data: [], error: null };
  const allVariations = [...new Map([...(variations.data ?? []), ...(relatedVariations.data ?? [])]
    .map((row) => [row.id, row])).values()];
  const inventoryIds = [...new Set([
    ...allListings.map((row) => row.inventory_id),
    ...allVariations.map((row) => row.inventory_id),
  ].filter((value): value is string => typeof value === "string" && Boolean(value)))];
  const full = inventoryIds.length
    ? await admin.from("ml_fulfillment_stock_states").select("*").eq("organization_id", organizationId).in("inventory_id", inventoryIds)
    : { data: [], error: null };
  const failed = [catalog, stock, relationships, links, conflicts, kit, components, productListings, variations, relatedListings, relatedVariations, alerts, full]
    .find((result) => result.error)?.error;
  if (failed) {
    console.error("Stock debug failed:", failed.message.slice(0, 500));
    return NextResponse.json({ error: "stock_debug_failed" }, { status: 500 });
  }
  return NextResponse.json({
    sourceProduct: { canonical: product, upsellerCatalog: catalog.data },
    stockState: stock.data,
    mappingRelationships: relationships.data,
    currentProductLinks: links.data,
    mappingConflicts: conflicts.data,
    kitData: kit.data ? { kit: kit.data, components: components.data } : null,
    currentMlListings: { listings: allListings, variations: allVariations },
    fullStates: full.data,
    alerts: alerts.data,
    intelligence,
  });
}
