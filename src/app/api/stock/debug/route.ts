import { NextResponse } from "next/server";

import { getAdminApiAccess } from "@/features/auth/get-admin-api-access";
import { getProductStockIntelligence } from "@/features/stock/get-product-stock-intelligence";
import { normalizeSku } from "@/features/stock/stock-domain";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * Colunas explícitas em vez de select("*").
 *
 * As duas tabelas com raw_payload guardam o JSON integral devolvido pela
 * origem, que domina o tamanho da resposta e raramente é o que se está
 * investigando. Por isso ele fica fora por padrão e volta sob ?raw=1,
 * mantendo o endpoint útil para os casos em que o payload bruto é
 * justamente a evidência procurada.
 */
const CATALOG_COLUMNS =
  "id,organization_id,source_sku,sku_key,spu,product_code,title,product_alias,invoice_alias_enabled,category,variant_dimensions,launch_date_raw,is_active,seller,retail_price,purchase_cost,description,brand,barcodes,sku_alias,images,weight_g,length_cm,width_cm,height_cm,ncm,cest,unit,origin,supplier_url,source_import_id,updated_at";
const STOCK_STATE_COLUMNS =
  "id,organization_id,source_sku,sku_key,title,warehouse_name,warehouse_key,shelf,low_stock_threshold,purchase_in_transit,transfer_in_transit,occupied_quantity,available_quantity,current_quantity,average_cost,stock_value,source_created_at_raw,state_hash,source_import_id,checked_at,created_at,updated_at";
const INVENTORY_LINK_COLUMNS =
  "id,organization_id,product_id,source,source_sku,source_sku_key,source_kind,link_method,confidence,source_import_id,evidence,is_active,created_at,updated_at";
const LINK_CONFLICT_COLUMNS =
  "id,organization_id,product_id,source,candidate_source_skus,evidence,source_import_id,is_current,created_at,updated_at,resolved_at";
const KIT_COLUMNS =
  "id,organization_id,kit_sku,kit_sku_key,title,alias,invoice_alias_enabled,category,is_active,image_url,source_import_id,is_current,created_at,updated_at,definition_source";
const KIT_COMPONENT_COLUMNS =
  "id,organization_id,kit_sku_key,component_sku,component_sku_key,required_quantity,source_import_id,is_current,created_at,updated_at,definition_source";
const ALERT_COLUMNS =
  "id,organization_id,product_id,alert_type,severity,status,dedupe_key,evidence,suggested_action_code,first_seen_at,last_seen_at,last_evaluated_at,resolved_at,created_at,updated_at";
const FULFILLMENT_STATE_COLUMNS =
  "id,organization_id,ml_account_id,inventory_id,total_quantity,available_quantity,not_available_quantity,not_available_detail,external_references,state_hash,checked_at,refresh_source,last_operation_id,created_at,updated_at";

function withRawPayload(columns: string, includeRaw: boolean) {
  return includeRaw ? `${columns},raw_payload` : columns;
}

/*
 * A lista de colunas é montada em runtime por causa do ?raw=1, então o
 * PostgREST não consegue inferir a forma da linha a partir de um literal.
 * Este tipo declara apenas o campo que o handler realmente lê; o resto
 * segue direto para o JSON de resposta.
 */
type ChannelRelationshipRow = {
  listing_external_id: string | null;
  [column: string]: unknown;
};

export async function GET(request: Request) {
  const authorization = await getAdminApiAccess();
  if (!authorization.access) return NextResponse.json({ error: "not_authorized" }, { status: authorization.status });
  const requestUrl = new URL(request.url);
  const sku = requestUrl.searchParams.get("sku")?.trim();
  if (!sku || sku.length > 120) return NextResponse.json({ error: "invalid_sku" }, { status: 400 });
  const includeRawPayload = requestUrl.searchParams.get("raw") === "1";
  const organizationId = authorization.access.organizationId;
  const skuKey = normalizeSku(sku);
  const admin = createAdminClient();
  const { data: product, error: productError } = await admin.from("products")
    .select("id,sku,sku_key,name,created_at,updated_at")
    .eq("organization_id", organizationId).eq("sku_key", skuKey).maybeSingle();
  if (productError) return NextResponse.json({ error: "product_lookup_failed" }, { status: 500 });
  if (!product) return NextResponse.json({ error: "product_not_found", sku, skuKey }, { status: 404 });

  const [catalog, stock, relationships, links, conflicts, kit, components, productListings, variations, alerts, intelligence] = await Promise.all([
    admin.from("upseller_product_catalog").select(withRawPayload(CATALOG_COLUMNS, includeRawPayload)).eq("organization_id", organizationId).eq("sku_key", skuKey).maybeSingle(),
    admin.from("upseller_stock_states").select(STOCK_STATE_COLUMNS).eq("organization_id", organizationId).eq("sku_key", skuKey).order("warehouse_key"),
    admin.from("upseller_channel_sku_relationships").select(withRawPayload("id,source_sku,source_sku_key,mapped_listing_sku,mapped_listing_sku_key,variant_label,listing_external_id,variant_external_id,store_name,store_name_key,channel,ml_account_id,source_updated_at_raw,is_current,source_import_id", includeRawPayload))
      .eq("organization_id", organizationId).eq("source_sku_key", skuKey).eq("is_current", true)
      .returns<ChannelRelationshipRow[]>(),
    admin.from("product_inventory_links").select(INVENTORY_LINK_COLUMNS).eq("organization_id", organizationId).eq("product_id", product.id).eq("is_active", true),
    admin.from("product_inventory_link_conflicts").select(LINK_CONFLICT_COLUMNS).eq("organization_id", organizationId).eq("product_id", product.id).eq("is_current", true),
    admin.from("upseller_kits").select(KIT_COLUMNS).eq("organization_id", organizationId).eq("kit_sku_key", skuKey).eq("is_current", true).maybeSingle(),
    admin.from("upseller_kit_components").select(KIT_COMPONENT_COLUMNS).eq("organization_id", organizationId).eq("kit_sku_key", skuKey).eq("is_current", true),
    admin.from("ml_listings").select("id,ml_account_id,product_id,item_id,user_product_id,inventory_id,title,seller_sku,status,available_quantity,is_current,ml_last_updated")
      .eq("organization_id", organizationId).eq("product_id", product.id).eq("is_current", true),
    admin.from("ml_listing_variations").select("id,ml_account_id,ml_listing_id,product_id,variation_id,seller_sku,user_product_id,inventory_id,available_quantity,is_current")
      .eq("organization_id", organizationId).eq("product_id", product.id).eq("is_current", true),
    admin.from("operational_alerts").select(ALERT_COLUMNS).eq("organization_id", organizationId).eq("product_id", product.id).order("created_at", { ascending: false }),
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
    ? await admin.from("ml_fulfillment_stock_states").select(withRawPayload(FULFILLMENT_STATE_COLUMNS, includeRawPayload)).eq("organization_id", organizationId).in("inventory_id", inventoryIds)
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
