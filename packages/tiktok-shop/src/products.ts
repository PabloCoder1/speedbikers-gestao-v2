import { z } from "zod";

import { MAX_UNIX_EPOCH_SECONDS } from "./auth.js";
import type { TikTokShopAuth, TikTokShopClient } from "./client.js";

/**
 * Catálogo e estoque do TikTok Shop (D-807) — `docs/TIKTOK_SHOP.md` §8:
 *
 * - busca de catálogo: `POST /product/202502/products/search` (`page_size` 1..100);
 * - detalhe (inclui congelados/apagados): `GET /product/202309/products/{product_id}`;
 * - estoque em lote: `POST /product/202309/inventory/search` (até 100 produtos
 *   ou 600 SKUs por chamada).
 */

export const PRODUCT_SEARCH_MAX_PAGE_SIZE = 100;
export const INVENTORY_SEARCH_MAX_PRODUCTS = 100;
export const INVENTORY_SEARCH_MAX_SKUS = 600;

const texto = z.string().nullable().optional();
const epochOpcional = z.number().int().positive().max(MAX_UNIX_EPOCH_SECONDS).nullable().optional();

const skuPriceSchema = z.object({
  currency: texto,
  tax_exclusive_price: texto,
  sale_price: texto,
});

const skuWarehouseStockSchema = z.object({
  warehouse_id: z.string().min(1),
  quantity: z.number().int().nonnegative(),
});

export const tiktokProductSkuSchema = z.object({
  id: z.string().min(1),
  seller_sku: texto,
  price: skuPriceSchema.nullable().optional(),
  inventory: z.array(skuWarehouseStockSchema).nullable().optional(),
});

export type TikTokProductSku = z.infer<typeof tiktokProductSkuSchema>;

export const tiktokProductSummarySchema = z.object({
  id: z.string().min(1),
  title: texto,
  status: z.string().min(1),
  create_time: epochOpcional,
  update_time: epochOpcional,
  skus: z.array(tiktokProductSkuSchema).nullable().optional(),
});

export type TikTokProductSummary = z.infer<typeof tiktokProductSummarySchema>;

const productsSearchResponseSchema = z.object({
  next_page_token: z.string().nullable().optional(),
  total_count: z.number().int().nonnegative().nullable().optional(),
  products: z.array(tiktokProductSummarySchema).nullable().optional(),
});

export const tiktokProductDetailSchema = tiktokProductSummarySchema.extend({
  is_cod_allowed: z.boolean().nullable().optional(),
});

export type TikTokProductDetail = z.infer<typeof tiktokProductDetailSchema>;

const inventoryWarehouseSchema = z.object({
  warehouse_id: z.string().min(1),
  available_quantity: z.number().int().nonnegative().nullable().optional(),
  committed_quantity: z.number().int().nonnegative().nullable().optional(),
});

export const tiktokInventorySkuSchema = z.object({
  id: z.string().min(1),
  seller_sku: texto,
  total_available_quantity: z.number().int().nonnegative().nullable().optional(),
  total_committed_quantity: z.number().int().nonnegative().nullable().optional(),
  warehouse_inventory: z.array(inventoryWarehouseSchema).nullable().optional(),
});

export const tiktokInventoryProductSchema = z.object({
  product_id: z.string().min(1),
  skus: z.array(tiktokInventorySkuSchema).nullable().optional(),
});

export type TikTokInventoryProduct = z.infer<typeof tiktokInventoryProductSchema>;

const inventorySearchResponseSchema = z.object({
  inventory: z.array(tiktokInventoryProductSchema).nullable().optional(),
});

export interface SearchProductsOptions {
  readonly pageSize?: number;
  readonly pageToken?: string;
  readonly status?: string;
  readonly sellerSkus?: readonly string[];
  readonly createTimeGe?: number;
  readonly createTimeLe?: number;
  readonly updateTimeGe?: number;
  readonly updateTimeLe?: number;
}

export interface TikTokProductsPage {
  readonly products: TikTokProductSummary[];
  readonly nextPageToken: string | null;
  readonly totalCount: number | null;
}

function validarEpoch(nome: string, valor: number | undefined): number | undefined {
  if (valor === undefined) return undefined;

  if (!Number.isSafeInteger(valor) || valor <= 0 || valor > MAX_UNIX_EPOCH_SECONDS) {
    throw new RangeError(`${nome} inválido: ${String(valor)}`);
  }

  return valor;
}

function validarJanelaInclusiva(nome: string, ge: number | undefined, le: number | undefined): void {
  const inicio = validarEpoch(`${nome}Ge`, ge);
  const fim = validarEpoch(`${nome}Le`, le);

  if (inicio !== undefined && fim !== undefined && inicio > fim) {
    throw new RangeError(`Janela ${nome} invertida: ${String(inicio)} > ${String(fim)}`);
  }
}

/** Busca paginada de produtos em `POST /product/202502/products/search`. */
export async function searchProductsPage(
  client: TikTokShopClient,
  shop: TikTokShopAuth,
  options: SearchProductsOptions = {},
): Promise<TikTokProductsPage> {
  const pageSize = options.pageSize ?? PRODUCT_SEARCH_MAX_PAGE_SIZE;

  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PRODUCT_SEARCH_MAX_PAGE_SIZE) {
    throw new RangeError(`pageSize de produtos deve ser inteiro entre 1 e ${String(PRODUCT_SEARCH_MAX_PAGE_SIZE)}`);
  }

  validarJanelaInclusiva("createTime", options.createTimeGe, options.createTimeLe);
  validarJanelaInclusiva("updateTime", options.updateTimeGe, options.updateTimeLe);

  const pageToken = options.pageToken?.trim();
  const query: Record<string, string> = {
    page_size: String(pageSize),
    ...(pageToken !== undefined && pageToken !== "" ? { page_token: pageToken } : {}),
  };

  const sellerSkus = options.sellerSkus?.map((sku) => sku.trim()).filter((sku) => sku !== "");
  const body: Record<string, unknown> = {
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(sellerSkus !== undefined && sellerSkus.length > 0 ? { seller_skus: [...new Set(sellerSkus)] } : {}),
    ...(options.createTimeGe !== undefined ? { create_time_ge: options.createTimeGe } : {}),
    ...(options.createTimeLe !== undefined ? { create_time_le: options.createTimeLe } : {}),
    ...(options.updateTimeGe !== undefined ? { update_time_ge: options.updateTimeGe } : {}),
    ...(options.updateTimeLe !== undefined ? { update_time_le: options.updateTimeLe } : {}),
  };

  const data = await client.request({
    method: "POST",
    path: "/product/202502/products/search",
    accessToken: shop.accessToken,
    shopCipher: shop.shopCipher,
    query,
    body,
    schema: productsSearchResponseSchema,
  });

  const nextTokenRaw = data.next_page_token?.trim() ?? "";
  const nextPageToken = nextTokenRaw === "" ? null : nextTokenRaw;

  if (nextPageToken !== null && pageToken !== undefined && pageToken !== "" && nextPageToken === pageToken) {
    throw new Error("A busca de produtos do TikTok Shop retornou cursor repetido na paginação.");
  }

  return {
    products: data.products ?? [],
    nextPageToken,
    totalCount: data.total_count ?? null,
  };
}

/** Detalhe do produto em `GET /product/202309/products/{product_id}`. */
export async function getProductDetail(
  client: TikTokShopClient,
  shop: TikTokShopAuth,
  productId: string,
): Promise<TikTokProductDetail> {
  const id = productId.trim();

  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new RangeError(`productId inválido para consulta no TikTok Shop: ${productId}`);
  }

  return await client.request({
    method: "GET",
    path: `/product/202309/products/${encodeURIComponent(id)}`,
    accessToken: shop.accessToken,
    shopCipher: shop.shopCipher,
    schema: tiktokProductDetailSchema,
  });
}

function normalizarIds(nome: string, ids: readonly string[] | undefined, max: number): string[] | undefined {
  if (ids === undefined) return undefined;

  const unicos: string[] = [];
  const vistos = new Set<string>();

  for (const raw of ids) {
    const id = raw.trim();

    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new RangeError(`${nome} inválido: ${raw}`);
    }

    if (!vistos.has(id)) {
      vistos.add(id);
      unicos.push(id);
    }
  }

  if (unicos.length > max) {
    throw new RangeError(`${nome} excede o teto de ${String(max)} itens por chamada`);
  }

  return unicos;
}

/** Consulta estoque em `POST /product/202309/inventory/search` (até 100 produtos ou 600 SKUs). */
export async function searchInventory(
  client: TikTokShopClient,
  shop: TikTokShopAuth,
  options: { readonly productIds?: readonly string[]; readonly skuIds?: readonly string[] },
): Promise<TikTokInventoryProduct[]> {
  const productIds = normalizarIds("productIds", options.productIds, INVENTORY_SEARCH_MAX_PRODUCTS);
  const skuIds = normalizarIds("skuIds", options.skuIds, INVENTORY_SEARCH_MAX_SKUS);

  if ((productIds === undefined || productIds.length === 0) && (skuIds === undefined || skuIds.length === 0)) {
    throw new RangeError("searchInventory exige ao menos um productId ou skuId");
  }

  const body: Record<string, unknown> = {
    ...(productIds !== undefined && productIds.length > 0 ? { product_ids: productIds } : {}),
    ...(skuIds !== undefined && skuIds.length > 0 ? { sku_ids: skuIds } : {}),
  };

  const data = await client.request({
    method: "POST",
    path: "/product/202309/inventory/search",
    accessToken: shop.accessToken,
    shopCipher: shop.shopCipher,
    body,
    schema: inventorySearchResponseSchema,
  });

  return data.inventory ?? [];
}
