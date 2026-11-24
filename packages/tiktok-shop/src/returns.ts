import { z } from "zod";

import { MAX_UNIX_EPOCH_SECONDS } from "./auth.js";
import type { TikTokShopAuth, TikTokShopClient } from "./client.js";

/**
 * Devoluções e cancelamentos do TikTok Shop (D-807) — `docs/TIKTOK_SHOP.md` §9:
 *
 * - devoluções: `POST /return_refund/202602/returns/search` (`page_size` 10..50);
 * - cancelamentos: `POST /return_refund/202602/cancellations/search` (`page_size` 10..50);
 * - status cancelado diverge entre webhook e API (`…_CANCEL` vs `…_CANCELLED`):
 *   `normalizeTikTokCancelStatus` unifica os dois;
 * - PII do comprador (`buyer_user_id`, etc.) é descartado pelos schemas.
 */

export const RETURN_SEARCH_MIN_PAGE_SIZE = 10;
export const RETURN_SEARCH_MAX_PAGE_SIZE = 50;

const texto = z.string().nullable().optional();
const epochOpcional = z.number().int().positive().max(MAX_UNIX_EPOCH_SECONDS).nullable().optional();

const refundAmountSchema = z.object({
  currency: texto,
  refund_total: texto,
  refund_subtotal: texto,
  refund_shipping_fee: texto,
  refund_tax: texto,
});

const returnLineItemSchema = z.object({
  return_line_item_id: texto,
  order_line_item_id: texto,
  sku_id: texto,
  seller_sku: texto,
  product_id: texto,
  product_name: texto,
  refund_amount: refundAmountSchema.nullable().optional(),
});

/** Devolução operacional do TikTok Shop — sem identificadores pessoais do comprador. */
export const tiktokReturnSchema = z.object({
  return_id: z.string().min(1),
  order_id: z.string().min(1),
  return_type: texto,
  return_status: z.string().min(1),
  arbitration_status: texto,
  return_reason: texto,
  return_reason_text: texto,
  create_time: epochOpcional,
  update_time: epochOpcional,
  refund_amount: refundAmountSchema.nullable().optional(),
  return_line_items: z.array(returnLineItemSchema).nullable().optional(),
});

export type TikTokReturn = z.infer<typeof tiktokReturnSchema>;

const returnsSearchResponseSchema = z.object({
  next_page_token: z.string().nullable().optional(),
  total_count: z.number().int().nonnegative().nullable().optional(),
  return_orders: z.array(tiktokReturnSchema).nullable().optional(),
});

/** Cancelamento operacional do TikTok Shop — sem identificadores pessoais do comprador. */
export const tiktokCancellationSchema = z.object({
  cancel_id: z.string().min(1),
  order_id: z.string().min(1),
  cancel_type: texto,
  cancel_status: z.string().min(1),
  cancel_reason: texto,
  cancel_reason_text: texto,
  role: texto,
  create_time: epochOpcional,
  update_time: epochOpcional,
  refund_amount: refundAmountSchema.nullable().optional(),
});

export type TikTokCancellation = z.infer<typeof tiktokCancellationSchema>;

const cancellationsSearchResponseSchema = z.object({
  next_page_token: z.string().nullable().optional(),
  total_count: z.number().int().nonnegative().nullable().optional(),
  cancellations: z.array(tiktokCancellationSchema).nullable().optional(),
});

export interface SearchReturnsOptions {
  readonly pageSize?: number;
  readonly pageToken?: string;
  readonly orderIds?: readonly string[];
  readonly returnTypes?: readonly string[];
  readonly returnStatus?: readonly string[];
  readonly createTimeGe?: number;
  readonly createTimeLt?: number;
  readonly updateTimeGe?: number;
  readonly updateTimeLt?: number;
}

export interface TikTokReturnsPage {
  readonly returns: TikTokReturn[];
  readonly nextPageToken: string | null;
  readonly totalCount: number | null;
}

export interface SearchCancellationsOptions {
  readonly pageSize?: number;
  readonly pageToken?: string;
  readonly orderIds?: readonly string[];
  readonly cancelTypes?: readonly string[];
  readonly cancelStatus?: readonly string[];
  readonly createTimeGe?: number;
  readonly createTimeLt?: number;
  readonly updateTimeGe?: number;
  readonly updateTimeLt?: number;
}

export interface TikTokCancellationsPage {
  readonly cancellations: TikTokCancellation[];
  readonly nextPageToken: string | null;
  readonly totalCount: number | null;
}

/** Normaliza divergência de sufixo entre webhook (`CANCEL` / `…_CANCEL`) e API (`CANCELLED` / `…_CANCELLED`). */
export function normalizeTikTokCancelStatus(status: string): string {
  const trimmed = status.trim();

  if (trimmed === "CANCEL") return "CANCELLED";
  if (trimmed.endsWith("_CANCEL")) return `${trimmed}LED`;

  return trimmed;
}

function validarPageSize(pageSize: number): void {
  if (!Number.isSafeInteger(pageSize) || pageSize < RETURN_SEARCH_MIN_PAGE_SIZE || pageSize > RETURN_SEARCH_MAX_PAGE_SIZE) {
    throw new RangeError(
      `pageSize de devoluções/cancelamentos deve ser inteiro entre ${String(RETURN_SEARCH_MIN_PAGE_SIZE)} e ${String(RETURN_SEARCH_MAX_PAGE_SIZE)}`,
    );
  }
}

function validarEpoch(nome: string, valor: number | undefined): number | undefined {
  if (valor === undefined) return undefined;

  if (!Number.isSafeInteger(valor) || valor <= 0 || valor > MAX_UNIX_EPOCH_SECONDS) {
    throw new RangeError(`${nome} inválido: ${String(valor)}`);
  }

  return valor;
}

function validarJanela(nome: string, ge: number | undefined, lt: number | undefined): void {
  const inicio = validarEpoch(`${nome}Ge`, ge);
  const fim = validarEpoch(`${nome}Lt`, lt);

  if (inicio !== undefined && fim !== undefined && inicio >= fim) {
    throw new RangeError(`Janela ${nome} invertida ou vazia: ${String(inicio)} >= ${String(fim)}`);
  }
}

/** Busca paginada de devoluções em `POST /return_refund/202602/returns/search`. */
export async function searchReturnsPage(
  client: TikTokShopClient,
  shop: TikTokShopAuth,
  options: SearchReturnsOptions = {},
): Promise<TikTokReturnsPage> {
  const pageSize = options.pageSize ?? RETURN_SEARCH_MAX_PAGE_SIZE;

  validarPageSize(pageSize);
  validarJanela("createTime", options.createTimeGe, options.createTimeLt);
  validarJanela("updateTime", options.updateTimeGe, options.updateTimeLt);

  const pageToken = options.pageToken?.trim();
  const query: Record<string, string> = {
    page_size: String(pageSize),
    ...(pageToken !== undefined && pageToken !== "" ? { page_token: pageToken } : {}),
  };

  const body: Record<string, unknown> = {
    ...(options.orderIds !== undefined && options.orderIds.length > 0 ? { order_ids: [...new Set(options.orderIds)] } : {}),
    ...(options.returnTypes !== undefined && options.returnTypes.length > 0 ? { return_types: [...options.returnTypes] } : {}),
    ...(options.returnStatus !== undefined && options.returnStatus.length > 0 ? { return_status: [...options.returnStatus] } : {}),
    ...(options.createTimeGe !== undefined ? { create_time_ge: options.createTimeGe } : {}),
    ...(options.createTimeLt !== undefined ? { create_time_lt: options.createTimeLt } : {}),
    ...(options.updateTimeGe !== undefined ? { update_time_ge: options.updateTimeGe } : {}),
    ...(options.updateTimeLt !== undefined ? { update_time_lt: options.updateTimeLt } : {}),
  };

  const data = await client.request({
    method: "POST",
    path: "/return_refund/202602/returns/search",
    accessToken: shop.accessToken,
    shopCipher: shop.shopCipher,
    query,
    body,
    schema: returnsSearchResponseSchema,
  });

  const nextTokenRaw = data.next_page_token?.trim() ?? "";
  const nextPageToken = nextTokenRaw === "" ? null : nextTokenRaw;

  if (nextPageToken !== null && pageToken !== undefined && pageToken !== "" && nextPageToken === pageToken) {
    throw new Error("A busca de devoluções do TikTok Shop retornou cursor repetido na paginação.");
  }

  return {
    returns: data.return_orders ?? [],
    nextPageToken,
    totalCount: data.total_count ?? null,
  };
}

/** Busca paginada de cancelamentos em `POST /return_refund/202602/cancellations/search`. */
export async function searchCancellationsPage(
  client: TikTokShopClient,
  shop: TikTokShopAuth,
  options: SearchCancellationsOptions = {},
): Promise<TikTokCancellationsPage> {
  const pageSize = options.pageSize ?? RETURN_SEARCH_MAX_PAGE_SIZE;

  validarPageSize(pageSize);
  validarJanela("createTime", options.createTimeGe, options.createTimeLt);
  validarJanela("updateTime", options.updateTimeGe, options.updateTimeLt);

  const pageToken = options.pageToken?.trim();
  const query: Record<string, string> = {
    page_size: String(pageSize),
    ...(pageToken !== undefined && pageToken !== "" ? { page_token: pageToken } : {}),
  };

  const body: Record<string, unknown> = {
    ...(options.orderIds !== undefined && options.orderIds.length > 0 ? { order_ids: [...new Set(options.orderIds)] } : {}),
    ...(options.cancelTypes !== undefined && options.cancelTypes.length > 0 ? { cancel_types: [...options.cancelTypes] } : {}),
    ...(options.cancelStatus !== undefined && options.cancelStatus.length > 0 ? { cancel_status: [...options.cancelStatus] } : {}),
    ...(options.createTimeGe !== undefined ? { create_time_ge: options.createTimeGe } : {}),
    ...(options.createTimeLt !== undefined ? { create_time_lt: options.createTimeLt } : {}),
    ...(options.updateTimeGe !== undefined ? { update_time_ge: options.updateTimeGe } : {}),
    ...(options.updateTimeLt !== undefined ? { update_time_lt: options.updateTimeLt } : {}),
  };

  const data = await client.request({
    method: "POST",
    path: "/return_refund/202602/cancellations/search",
    accessToken: shop.accessToken,
    shopCipher: shop.shopCipher,
    query,
    body,
    schema: cancellationsSearchResponseSchema,
  });

  const nextTokenRaw = data.next_page_token?.trim() ?? "";
  const nextPageToken = nextTokenRaw === "" ? null : nextTokenRaw;

  if (nextPageToken !== null && pageToken !== undefined && pageToken !== "" && nextPageToken === pageToken) {
    throw new Error("A busca de cancelamentos do TikTok Shop retornou cursor repetido na paginação.");
  }

  return {
    cancellations: data.cancellations ?? [],
    nextPageToken,
    totalCount: data.total_count ?? null,
  };
}
