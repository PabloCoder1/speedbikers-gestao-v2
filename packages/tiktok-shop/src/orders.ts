import { z } from "zod";

import { MAX_UNIX_EPOCH_SECONDS } from "./auth.js";
import { parseTikTokDecimal, type TikTokShopAuth, type TikTokShopClient } from "./client.js";

/**
 * Pedidos do TikTok Shop (D-807) — P`get-order-list-202309` e
 * P`get-order-detail-202507`, conferidos em `docs/TIKTOK_SHOP.md` §6 e §13:
 *
 * - busca: `POST /order/202309/orders/search` (`page_size` 1..100, `page_token`);
 * - detalhe: `GET /order/202507/orders?ids=...` (até 50 IDs por chamada);
 * - `line_items[]` vem com UMA LINHA POR UNIDADE (sem campo de quantidade);
 * - a V3 nunca guarda dados pessoais do comprador (`cpf`, `cpf_name`,
 *   `buyer_email`, `recipient_address`): o schema `z.object` descarta tudo o
 *   que não é dado operacional do pedido.
 */

export const ORDER_SEARCH_MIN_PAGE_SIZE = 1;
export const ORDER_SEARCH_MAX_PAGE_SIZE = 100;
export const ORDER_DETAIL_MAX_BATCH = 50;

export const TIKTOK_ORDER_STATUSES = [
  "UNPAID",
  "ON_HOLD",
  "AWAITING_SHIPMENT",
  "PARTIALLY_SHIPPING",
  "AWAITING_COLLECTION",
  "IN_TRANSIT",
  "DELIVERED",
  "COMPLETED",
  "CANCELLED",
] as const;

export type TikTokOrderStatus = (typeof TIKTOK_ORDER_STATUSES)[number];

const texto = z.string().nullable().optional();
const epochOpcional = z.number().int().positive().max(MAX_UNIX_EPOCH_SECONDS).nullable().optional();

export const tiktokCombinedListingSkuSchema = z.object({
  sku_id: texto,
  seller_sku: texto,
  product_id: texto,
  sku_count: z.number().int().nonnegative().nullable().optional(),
});

export type TikTokCombinedListingSku = z.infer<typeof tiktokCombinedListingSkuSchema>;

export const tiktokLineItemSchema = z.object({
  id: z.string().min(1),
  sku_id: texto,
  seller_sku: texto,
  product_id: texto,
  product_name: texto,
  sku_name: texto,
  sale_price: texto,
  original_price: texto,
  seller_discount: texto,
  platform_discount: texto,
  currency: texto,
  is_gift: z.boolean().nullable().optional(),
  display_status: texto,
  cancel_reason: texto,
  cancel_user: texto,
  combined_listing_skus: z.array(tiktokCombinedListingSkuSchema).nullable().optional(),
});

export type TikTokLineItem = z.infer<typeof tiktokLineItemSchema>;

export const tiktokPaymentSchema = z.object({
  currency: texto,
  sub_total: texto,
  shipping_fee: texto,
  seller_discount: texto,
  platform_discount: texto,
  shipping_fee_seller_discount: texto,
  shipping_fee_platform_discount: texto,
  total_amount: texto,
  tax: texto,
  original_total_product_price: texto,
  original_shipping_fee: texto,
});

export type TikTokPayment = z.infer<typeof tiktokPaymentSchema>;

/** Pedido operacional do TikTok Shop — sem PII de comprador (§13). */
export const tiktokOrderSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  create_time: z.number().int().positive().max(MAX_UNIX_EPOCH_SECONDS),
  update_time: z.number().int().positive().max(MAX_UNIX_EPOCH_SECONDS),
  paid_time: epochOpcional,
  fulfillment_type: texto,
  shipping_type: texto,
  shipping_provider: texto,
  payment_method_name: texto,
  cancel_reason: texto,
  cancellation_initiator: texto,
  cancel_time: epochOpcional,
  is_buyer_request_cancel: z.boolean().nullable().optional(),
  request_cancel_time: epochOpcional,
  payment: tiktokPaymentSchema.nullable().optional(),
  line_items: z.array(tiktokLineItemSchema).nullable().optional(),
});

export type TikTokOrder = z.infer<typeof tiktokOrderSchema>;

const orderSearchResponseSchema = z.object({
  next_page_token: z.string().nullable().optional(),
  total_count: z.number().int().nonnegative().nullable().optional(),
  orders: z.array(tiktokOrderSchema).nullable().optional(),
});

const orderDetailResponseSchema = z.object({
  orders: z.array(tiktokOrderSchema).nullable().optional(),
});

export interface SearchOrdersOptions {
  readonly pageSize?: number;
  readonly pageToken?: string;
  readonly sortField?: "create_time" | "update_time";
  readonly sortOrder?: "ASC" | "DESC";
  readonly updateTimeGe?: number;
  readonly updateTimeLt?: number;
  readonly createTimeGe?: number;
  readonly createTimeLt?: number;
  readonly orderStatus?: TikTokOrderStatus;
  readonly shippingType?: "TIKTOK" | "SELLER";
}

export interface TikTokOrderPage {
  readonly orders: TikTokOrder[];
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

function validarJanela(nomeBase: string, ge: number | undefined, lt: number | undefined): void {
  const inicio = validarEpoch(`${nomeBase}Ge`, ge);
  const fim = validarEpoch(`${nomeBase}Lt`, lt);

  if (inicio !== undefined && fim !== undefined && inicio >= fim) {
    throw new RangeError(`Janela ${nomeBase} invertida ou vazia: ${String(inicio)} >= ${String(fim)}`);
  }
}

/** Uma página de pedidos em `POST /order/202309/orders/search`. */
export async function searchOrdersPage(
  client: TikTokShopClient,
  shop: TikTokShopAuth,
  options: SearchOrdersOptions = {},
): Promise<TikTokOrderPage> {
  const pageSize = options.pageSize ?? ORDER_SEARCH_MAX_PAGE_SIZE;

  if (!Number.isSafeInteger(pageSize) || pageSize < ORDER_SEARCH_MIN_PAGE_SIZE || pageSize > ORDER_SEARCH_MAX_PAGE_SIZE) {
    throw new RangeError(
      `pageSize deve ser inteiro entre ${String(ORDER_SEARCH_MIN_PAGE_SIZE)} e ${String(ORDER_SEARCH_MAX_PAGE_SIZE)}`,
    );
  }

  validarJanela("updateTime", options.updateTimeGe, options.updateTimeLt);
  validarJanela("createTime", options.createTimeGe, options.createTimeLt);

  const pageToken = options.pageToken?.trim();
  const query: Record<string, string> = {
    page_size: String(pageSize),
    ...(pageToken !== undefined && pageToken !== "" ? { page_token: pageToken } : {}),
    ...(options.sortField !== undefined ? { sort_field: options.sortField } : {}),
    ...(options.sortOrder !== undefined ? { sort_order: options.sortOrder } : {}),
  };

  const body: Record<string, unknown> = {
    ...(options.updateTimeGe !== undefined ? { update_time_ge: options.updateTimeGe } : {}),
    ...(options.updateTimeLt !== undefined ? { update_time_lt: options.updateTimeLt } : {}),
    ...(options.createTimeGe !== undefined ? { create_time_ge: options.createTimeGe } : {}),
    ...(options.createTimeLt !== undefined ? { create_time_lt: options.createTimeLt } : {}),
    ...(options.orderStatus !== undefined ? { order_status: options.orderStatus } : {}),
    ...(options.shippingType !== undefined ? { shipping_type: options.shippingType } : {}),
  };

  const data = await client.request({
    method: "POST",
    path: "/order/202309/orders/search",
    accessToken: shop.accessToken,
    shopCipher: shop.shopCipher,
    query,
    body,
    schema: orderSearchResponseSchema,
  });

  const nextTokenRaw = data.next_page_token?.trim() ?? "";
  const nextPageToken = nextTokenRaw === "" ? null : nextTokenRaw;

  if (nextPageToken !== null && pageToken !== undefined && pageToken !== "" && nextPageToken === pageToken) {
    throw new Error("A busca de pedidos do TikTok Shop retornou cursor repetido na paginação.");
  }

  return {
    orders: data.orders ?? [],
    nextPageToken,
    totalCount: data.total_count ?? null,
  };
}

/** Detalhe de até 50 pedidos em `GET /order/202507/orders`. */
export async function getOrderDetail(
  client: TikTokShopClient,
  shop: TikTokShopAuth,
  orderIds: readonly string[],
): Promise<TikTokOrder[]> {
  if (orderIds.length === 0) return [];

  const normalizados: string[] = [];
  const vistos = new Set<string>();

  for (const rawId of orderIds) {
    const id = rawId.trim();

    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new RangeError(`Identificador de pedido TikTok inválido: ${rawId}`);
    }

    if (!vistos.has(id)) {
      vistos.add(id);
      normalizados.push(id);
    }
  }

  if (normalizados.length > ORDER_DETAIL_MAX_BATCH) {
    throw new RangeError(`getOrderDetail aceita no máximo ${String(ORDER_DETAIL_MAX_BATCH)} pedidos por chamada`);
  }

  const data = await client.request({
    method: "GET",
    path: "/order/202507/orders",
    accessToken: shop.accessToken,
    shopCipher: shop.shopCipher,
    query: { ids: normalizados.join(",") },
    schema: orderDetailResponseSchema,
  });

  return data.orders ?? [];
}

export interface AggregatedTikTokLineItem {
  readonly skuId: string | null;
  readonly sellerSku: string | null;
  readonly productId: string | null;
  readonly isGift: boolean;
  readonly quantity: number;
  readonly lineItemIds: string[];
  readonly salePriceTotal: number | null;
  readonly originalPriceTotal: number | null;
  readonly sellerDiscountTotal: number | null;
  readonly platformDiscountTotal: number | null;
  readonly combinedListingSkus: TikTokCombinedListingSku[];
}

function somarOpcional(acumulado: number | null, parcela: number | null): number | null {
  if (parcela === null) return acumulado;

  const soma = (acumulado ?? 0) + parcela;

  return Math.round(soma * 1_000_000) / 1_000_000;
}

function textoOuNulo(valor: string | null | undefined): string | null {
  if (valor === null || valor === undefined) return null;

  const limpo = valor.trim();

  return limpo === "" ? null : limpo;
}

/**
 * Converte `line_items[]` do TikTok Shop (1 linha por unidade, sem campo de
 * quantidade — `docs/TIKTOK_SHOP.md` §6) em itens agregados por SKU/brinde,
 * preservando componentes de bundle virtual (`combined_listing_skus`) e
 * mantendo ausência de preço como `null`.
 */
export function aggregateTikTokLineItems(lineItems: readonly TikTokLineItem[]): AggregatedTikTokLineItem[] {
  const grupos = new Map<
    string,
    {
      skuId: string | null;
      sellerSku: string | null;
      productId: string | null;
      isGift: boolean;
      quantity: number;
      lineItemIds: string[];
      salePriceTotal: number | null;
      originalPriceTotal: number | null;
      sellerDiscountTotal: number | null;
      platformDiscountTotal: number | null;
      combinedByKey: Map<string, TikTokCombinedListingSku>;
    }
  >();

  for (const item of lineItems) {
    const skuId = textoOuNulo(item.sku_id);
    const sellerSku = textoOuNulo(item.seller_sku);
    const productId = textoOuNulo(item.product_id);
    const isGift = item.is_gift === true;
    const key = `${skuId ?? ""}\u0000${sellerSku ?? ""}\u0000${productId ?? ""}\u0000${isGift ? "1" : "0"}`;

    let grupo = grupos.get(key);

    if (grupo === undefined) {
      grupo = {
        skuId,
        sellerSku,
        productId,
        isGift,
        quantity: 0,
        lineItemIds: [],
        salePriceTotal: null,
        originalPriceTotal: null,
        sellerDiscountTotal: null,
        platformDiscountTotal: null,
        combinedByKey: new Map(),
      };
      grupos.set(key, grupo);
    }

    grupo.quantity += 1;
    grupo.lineItemIds.push(item.id);
    grupo.salePriceTotal = somarOpcional(grupo.salePriceTotal, parseTikTokDecimal(item.sale_price));
    grupo.originalPriceTotal = somarOpcional(grupo.originalPriceTotal, parseTikTokDecimal(item.original_price));
    grupo.sellerDiscountTotal = somarOpcional(grupo.sellerDiscountTotal, parseTikTokDecimal(item.seller_discount));
    grupo.platformDiscountTotal = somarOpcional(grupo.platformDiscountTotal, parseTikTokDecimal(item.platform_discount));

    for (const comp of item.combined_listing_skus ?? []) {
      const compKey = `${comp.sku_id ?? ""}\u0000${comp.seller_sku ?? ""}\u0000${comp.product_id ?? ""}`;

      if (!grupo.combinedByKey.has(compKey)) {
        grupo.combinedByKey.set(compKey, comp);
      }
    }
  }

  return [...grupos.values()].map((grupo) => ({
    skuId: grupo.skuId,
    sellerSku: grupo.sellerSku,
    productId: grupo.productId,
    isGift: grupo.isGift,
    quantity: grupo.quantity,
    lineItemIds: grupo.lineItemIds,
    salePriceTotal: grupo.salePriceTotal,
    originalPriceTotal: grupo.originalPriceTotal,
    sellerDiscountTotal: grupo.sellerDiscountTotal,
    platformDiscountTotal: grupo.platformDiscountTotal,
    combinedListingSkus: [...grupo.combinedByKey.values()],
  }));
}
