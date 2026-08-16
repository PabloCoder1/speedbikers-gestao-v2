import "server-only";

import { parseNfeXml } from "@/features/stock/nfe-parser";
import { normalizeSku, sha256 } from "@/features/stock/stock-domain";
import { createAdminClient } from "@/lib/supabase/admin";

type StockStateRow = {
  id: string;
  source_sku: string;
  sku_key: string;
  warehouse_name: string;
  warehouse_key: string;
  source_import_id: string;
};

type InventoryLinkRow = {
  product_id: string;
  source_sku_key: string;
};

type ProductRow = {
  id: string;
  sku: string;
  name: string | null;
};

export type StockReceiptIssue = {
  code: string;
  message: string;
  lineNumber?: number;
  supplierSku?: string;
};

export type ResolvedNfeReceiptItem = {
  lineNumber: number;
  supplierSku: string;
  skuKey: string;
  description: string | null;
  unit: string | null;
  quantity: number;
  unitValue: number | null;
  totalValue: number | null;
  matched: boolean;
  productId: string | null;
  productSku: string | null;
  productName: string | null;
  stockStateId: string | null;
  baselineImportId: string | null;
  issue: string | null;
};

export type NfeStockReceiptResolution = {
  sourceSha256: string;
  duplicate: boolean;
  invoice: ReturnType<typeof parseNfeXml>;
  warehouse: {
    key: string;
    name: string;
  } | null;
  items: ResolvedNfeReceiptItem[];
  blockingIssues: StockReceiptIssue[];
  totalQuantity: number;
  matchedItemCount: number;
};

function pushToMap<T>(map: Map<string, T[]>, key: string, value: T) {
  const rows = map.get(key);
  if (rows) rows.push(value);
  else map.set(key, [value]);
}

export async function resolveNfeStockReceipt({
  organizationId,
  warehouseKey,
  xmlBuffer,
}: {
  organizationId: string;
  warehouseKey: string;
  xmlBuffer: Buffer;
}): Promise<NfeStockReceiptResolution> {
  const normalizedWarehouseKey = warehouseKey.trim().toUpperCase();
  if (!normalizedWarehouseKey || normalizedWarehouseKey.length > 160) {
    throw new Error("invalid_warehouse");
  }

  const invoice = parseNfeXml(xmlBuffer);
  const sourceSha256 = sha256(xmlBuffer);
  const skuKeys = [...new Set(invoice.items.map((item) => normalizeSku(item.supplierSku)))];
  const admin = createAdminClient();

  const [duplicateResult, statesResult, linksResult] = await Promise.all([
    admin
      .from("stock_receipts")
      .select("id")
      .eq("organization_id", organizationId)
      .or(`access_key.eq.${invoice.accessKey},source_sha256.eq.${sourceSha256}`)
      .limit(1),
    admin
      .from("upseller_stock_states")
      .select("id,source_sku,sku_key,warehouse_name,warehouse_key,source_import_id")
      .eq("organization_id", organizationId)
      .eq("warehouse_key", normalizedWarehouseKey)
      .in("sku_key", skuKeys)
      .returns<StockStateRow[]>(),
    admin
      .from("product_inventory_links")
      .select("product_id,source_sku_key")
      .eq("organization_id", organizationId)
      .eq("source", "upseller")
      .eq("is_active", true)
      .in("source_sku_key", skuKeys)
      .returns<InventoryLinkRow[]>(),
  ]);

  const backendMissing = duplicateResult.error
    ? duplicateResult.error.code === "42P01" ||
      duplicateResult.error.code === "PGRST205" ||
      duplicateResult.error.message.includes("stock_receipts")
    : false;
  if (duplicateResult.error && !backendMissing) {
    throw new Error(`stock_receipt_duplicate_lookup_failed:${duplicateResult.error.message}`);
  }
  if (statesResult.error) {
    throw new Error(`stock_receipt_state_lookup_failed:${statesResult.error.message}`);
  }
  if (linksResult.error) {
    throw new Error(`stock_receipt_link_lookup_failed:${linksResult.error.message}`);
  }

  const statesBySku = new Map((statesResult.data ?? []).map((state) => [state.sku_key, state]));
  const linksBySku = new Map<string, InventoryLinkRow[]>();
  for (const link of linksResult.data ?? []) pushToMap(linksBySku, link.source_sku_key, link);

  const productIds = [...new Set((linksResult.data ?? []).map((link) => link.product_id))];
  const productsResult = productIds.length
    ? await admin
        .from("products")
        .select("id,sku,name")
        .eq("organization_id", organizationId)
        .in("id", productIds)
        .returns<ProductRow[]>()
    : { data: [] as ProductRow[], error: null };

  if (productsResult.error) {
    throw new Error(`stock_receipt_product_lookup_failed:${productsResult.error.message}`);
  }
  const productsById = new Map((productsResult.data ?? []).map((product) => [product.id, product]));
  const blockingIssues: StockReceiptIssue[] = [];
  const duplicate = (duplicateResult.data?.length ?? 0) > 0;

  if (backendMissing) {
    blockingIssues.push({
      code: "stock_receipt_backend_unavailable",
      message: "A estrutura de entrada por NF-e ainda não foi aplicada ao banco de dados.",
    });
  }
  if (duplicate) {
    blockingIssues.push({
      code: "duplicate_invoice",
      message: "Esta NF-e já foi utilizada para dar entrada no estoque.",
    });
  }

  const items = invoice.items.map((item) => {
    const skuKey = normalizeSku(item.supplierSku);
    const state = statesBySku.get(skuKey) ?? null;
    const links = linksBySku.get(skuKey) ?? [];
    const link = links.length === 1 ? links[0] : null;
    const product = link ? productsById.get(link.product_id) ?? null : null;
    let issue: string | null = null;
    let issueCode: string | null = null;

    if (!state) {
      issueCode = "stock_state_not_found";
      issue = "SKU não encontrado no depósito selecionado.";
    } else if (links.length === 0 || !product) {
      issueCode = "product_link_not_found";
      issue = "SKU do XML ainda não está vinculado a um produto do sistema.";
    } else if (links.length > 1) {
      issueCode = "product_link_conflict";
      issue = "SKU possui mais de um vínculo ativo e precisa ser revisado.";
    }

    if (issue && issueCode) {
      blockingIssues.push({
        code: issueCode,
        message: issue,
        lineNumber: item.lineNumber,
        supplierSku: item.supplierSku,
      });
    }

    return {
      ...item,
      skuKey,
      matched: !issue,
      productId: issue ? null : product?.id ?? null,
      productSku: issue ? null : product?.sku ?? null,
      productName: issue ? null : product?.name ?? null,
      stockStateId: issue ? null : state?.id ?? null,
      baselineImportId: issue ? null : state?.source_import_id ?? null,
      issue,
    };
  });

  const warehouse = (statesResult.data ?? [])[0];
  return {
    sourceSha256,
    duplicate,
    invoice,
    warehouse: warehouse
      ? { key: warehouse.warehouse_key, name: warehouse.warehouse_name }
      : null,
    items,
    blockingIssues,
    totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
    matchedItemCount: items.filter((item) => item.matched).length,
  };
}
