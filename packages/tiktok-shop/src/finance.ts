import { z } from "zod";

import { MAX_UNIX_EPOCH_SECONDS } from "./auth.js";
import type { TikTokShopAuth, TikTokShopClient } from "./client.js";

/**
 * Financeiro do TikTok Shop (D-807) — `docs/TIKTOK_SHOP.md` §7 e contratos
 * oficiais `202309` / `202501` / `202507`:
 *
 * - extratos diários: `GET /finance/202309/statements`;
 * - transações por pedido (por SKU, incluindo `fee_per_item_sold_amount` do
 *   Brasil): `GET /finance/202501/orders/{order_id}/statement_transactions`;
 * - pedidos não liquidados (estimativa): `GET /finance/202507/orders/unsettled`.
 */

export const FINANCE_MAX_PAGE_SIZE = 100;

const texto = z.string().nullable().optional();
const epochOpcional = z.number().int().positive().max(MAX_UNIX_EPOCH_SECONDS).nullable().optional();

export const tiktokStatementSchema = z.object({
  id: z.string().min(1),
  statement_time: epochOpcional,
  settlement_amount: texto,
  revenue_amount: texto,
  fee_amount: texto,
  adjustment_amount: texto,
  shipping_cost_amount: texto,
  net_sales_amount: texto,
  currency: texto,
  payment_status: texto,
  payment_id: texto,
});

export type TikTokStatement = z.infer<typeof tiktokStatementSchema>;

const statementsResponseSchema = z.object({
  next_page_token: z.string().nullable().optional(),
  statements: z.array(tiktokStatementSchema).nullable().optional(),
});

export interface StatementsPageOptions {
  readonly statementTimeGe?: number;
  readonly statementTimeLt?: number;
  readonly paymentStatus?: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
  readonly sortField?: "statement_time";
  readonly sortOrder?: "ASC" | "DESC";
}

export interface TikTokStatementsPage {
  readonly statements: TikTokStatement[];
  readonly nextPageToken: string | null;
}

export const tiktokSkuTransactionSchema = z.object({
  sku_id: texto,
  sku_name: texto,
  quantity: z.number().int().nonnegative().nullable().optional(),
  settlement_amount: texto,
  revenue_amount: texto,
  fee_and_tax_amount: texto,
  shipping_cost_amount: texto,
  fee_per_item_sold_amount: texto,
  referral_fee_amount: texto,
  transaction_fee_amount: texto,
  affiliate_commission_amount: texto,
});

export type TikTokSkuTransaction = z.infer<typeof tiktokSkuTransactionSchema>;

export const tiktokOrderStatementTransactionSchema = z.object({
  order_id: z.string().min(1),
  order_create_time: epochOpcional,
  currency: texto,
  revenue_amount: texto,
  settlement_amount: texto,
  fee_and_tax_amount: texto,
  shipping_cost_amount: texto,
  sku_transactions: z.array(tiktokSkuTransactionSchema).nullable().optional(),
});

export type TikTokOrderStatementTransaction = z.infer<typeof tiktokOrderStatementTransactionSchema>;

export const tiktokUnsettledOrderSchema = z.object({
  order_id: z.string().min(1),
  order_create_time: epochOpcional,
  currency: texto,
  est_settlement_amount: texto,
  est_revenue_amount: texto,
  est_fee_amount: texto,
  est_adjustment_amount: texto,
  est_shipping_cost_amount: texto,
});

export type TikTokUnsettledOrder = z.infer<typeof tiktokUnsettledOrderSchema>;

const unsettledOrdersResponseSchema = z.object({
  next_page_token: z.string().nullable().optional(),
  total_count: z.number().int().nonnegative().nullable().optional(),
  orders: z.array(tiktokUnsettledOrderSchema).nullable().optional(),
});

export interface UnsettledOrdersOptions {
  readonly pageSize?: number;
  readonly pageToken?: string;
  readonly sortField?: "order_create_time";
  readonly sortOrder?: "ASC" | "DESC";
}

export interface TikTokUnsettledOrdersPage {
  readonly orders: TikTokUnsettledOrder[];
  readonly nextPageToken: string | null;
  readonly totalCount: number | null;
}

function validarPageSize(pageSize: number): void {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > FINANCE_MAX_PAGE_SIZE) {
    throw new RangeError(`pageSize financeiro deve ser inteiro entre 1 e ${String(FINANCE_MAX_PAGE_SIZE)}`);
  }
}

function validarEpoch(nome: string, valor: number | undefined): number | undefined {
  if (valor === undefined) return undefined;

  if (!Number.isSafeInteger(valor) || valor <= 0 || valor > MAX_UNIX_EPOCH_SECONDS) {
    throw new RangeError(`${nome} inválido: ${String(valor)}`);
  }

  return valor;
}

/** Lista extratos diários em `GET /finance/202309/statements`. */
export async function getStatementsPage(
  client: TikTokShopClient,
  shop: TikTokShopAuth,
  options: StatementsPageOptions = {},
): Promise<TikTokStatementsPage> {
  const pageSize = options.pageSize ?? FINANCE_MAX_PAGE_SIZE;

  validarPageSize(pageSize);

  const ge = validarEpoch("statementTimeGe", options.statementTimeGe);
  const lt = validarEpoch("statementTimeLt", options.statementTimeLt);

  if (ge !== undefined && lt !== undefined && ge >= lt) {
    throw new RangeError(`Janela de extratos invertida ou vazia: ${String(ge)} >= ${String(lt)}`);
  }

  const pageToken = options.pageToken?.trim();
  const query: Record<string, string> = {
    page_size: String(pageSize),
    ...(ge !== undefined ? { statement_time_ge: String(ge) } : {}),
    ...(lt !== undefined ? { statement_time_lt: String(lt) } : {}),
    ...(options.paymentStatus !== undefined ? { payment_status: options.paymentStatus } : {}),
    ...(pageToken !== undefined && pageToken !== "" ? { page_token: pageToken } : {}),
    ...(options.sortField !== undefined ? { sort_field: options.sortField } : {}),
    ...(options.sortOrder !== undefined ? { sort_order: options.sortOrder } : {}),
  };

  const data = await client.request({
    method: "GET",
    path: "/finance/202309/statements",
    accessToken: shop.accessToken,
    shopCipher: shop.shopCipher,
    query,
    schema: statementsResponseSchema,
  });

  const nextTokenRaw = data.next_page_token?.trim() ?? "";
  const nextPageToken = nextTokenRaw === "" ? null : nextTokenRaw;

  if (nextPageToken !== null && pageToken !== undefined && pageToken !== "" && nextPageToken === pageToken) {
    throw new Error("A listagem de extratos do TikTok Shop retornou cursor repetido na paginação.");
  }

  return { statements: data.statements ?? [], nextPageToken };
}

/** Transações liquidadas por pedido/SKU em `GET /finance/202501/orders/{order_id}/statement_transactions`. */
export async function getOrderStatementTransactions(
  client: TikTokShopClient,
  shop: TikTokShopAuth,
  orderId: string,
): Promise<TikTokOrderStatementTransaction> {
  const id = orderId.trim();

  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new RangeError(`orderId inválido para consulta financeira do TikTok Shop: ${orderId}`);
  }

  return await client.request({
    method: "GET",
    path: `/finance/202501/orders/${encodeURIComponent(id)}/statement_transactions`,
    accessToken: shop.accessToken,
    shopCipher: shop.shopCipher,
    schema: tiktokOrderStatementTransactionSchema,
  });
}

/** Estimativa de pedidos ainda não liquidados em `GET /finance/202507/orders/unsettled`. */
export async function getUnsettledOrdersPage(
  client: TikTokShopClient,
  shop: TikTokShopAuth,
  options: UnsettledOrdersOptions = {},
): Promise<TikTokUnsettledOrdersPage> {
  const pageSize = options.pageSize ?? FINANCE_MAX_PAGE_SIZE;

  validarPageSize(pageSize);

  const pageToken = options.pageToken?.trim();
  const query: Record<string, string> = {
    page_size: String(pageSize),
    ...(pageToken !== undefined && pageToken !== "" ? { page_token: pageToken } : {}),
    ...(options.sortField !== undefined ? { sort_field: options.sortField } : {}),
    ...(options.sortOrder !== undefined ? { sort_order: options.sortOrder } : {}),
  };

  const data = await client.request({
    method: "GET",
    path: "/finance/202507/orders/unsettled",
    accessToken: shop.accessToken,
    shopCipher: shop.shopCipher,
    query,
    schema: unsettledOrdersResponseSchema,
  });

  const nextTokenRaw = data.next_page_token?.trim() ?? "";
  const nextPageToken = nextTokenRaw === "" ? null : nextTokenRaw;

  if (nextPageToken !== null && pageToken !== undefined && pageToken !== "" && nextPageToken === pageToken) {
    throw new Error("A listagem de pedidos não liquidados do TikTok Shop retornou cursor repetido na paginação.");
  }

  return {
    orders: data.orders ?? [],
    nextPageToken,
    totalCount: data.total_count ?? null,
  };
}
