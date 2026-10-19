import { z } from "zod";

import type { ShopeeClient } from "./client.js";

/**
 * Pedidos (D-426) — `v2.order.get_order_list` e `v2.order.get_order_detail`,
 * conferidos na referência oficial em 13/10/2026.
 *
 * - A lista é por janela de `create_time` ou `update_time`, de no máximo 15
 *   dias, até 100 por página, com cursor (`more` + `next_cursor`).
 * - O detalhe aceita até 50 `order_sn` por chamada; itens, valor total e
 *   pagamento só vêm se pedidos em `response_optional_fields`.
 * - Dados do comprador vêm mascarados sem acesso a Sensitive Data — e a V3
 *   não os pede.
 */

/** A janela máxima de uma chamada da lista (documentação). */
export const ORDER_LIST_MAX_WINDOW_S = 15 * 24 * 3600;
export const ORDER_LIST_PAGE_SIZE = 100;
export const ORDER_DETAIL_BATCH = 50;

const orderListSchema = z.object({
  response: z.object({
    more: z.boolean(),
    next_cursor: z.string().nullable().optional(),
    order_list: z.array(z.object({ order_sn: z.string().min(1) })),
  }),
});

export interface OrderListPage {
  orderSns: string[];
  nextCursor: string | null;
}

/** Uma página de `order_sn` da janela (`timeFrom`/`timeTo` em epoch, segundos). */
export async function getOrderListPage(
  client: ShopeeClient,
  shop: { accessToken: string; shopId: number },
  options: { timeRangeField: "create_time" | "update_time"; timeFrom: number; timeTo: number; cursor?: string },
): Promise<OrderListPage> {
  const resposta = await client.request({
    method: "GET",
    path: "/api/v2/order/get_order_list",
    shop,
    query: {
      time_range_field: options.timeRangeField,
      time_from: String(options.timeFrom),
      time_to: String(options.timeTo),
      page_size: String(ORDER_LIST_PAGE_SIZE),
      ...(options.cursor === undefined || options.cursor === "" ? {} : { cursor: options.cursor }),
    },
    schema: orderListSchema,
  });

  return {
    orderSns: resposta.response.order_list.map((pedido) => pedido.order_sn),
    nextCursor: resposta.response.more ? (resposta.response.next_cursor ?? null) : null,
  };
}

const orderItemSchema = z.object({
  item_id: z.number().int(),
  item_name: z.string().nullable().optional(),
  item_sku: z.string().nullable().optional(),
  model_id: z.number().int().nullable().optional(),
  model_name: z.string().nullable().optional(),
  model_sku: z.string().nullable().optional(),
  model_quantity_purchased: z.number().int().nonnegative(),
  model_original_price: z.number().nullable().optional(),
  // 0 em item de bundle deal (documentação): o preço do item fica com o financeiro.
  model_discounted_price: z.number().nullable().optional(),
  promotion_type: z.string().nullable().optional(),
});

export const shopeeOrderSchema = z.object({
  order_sn: z.string().min(1),
  order_status: z.string().min(1),
  currency: z.string().nullable().optional(),
  cod: z.boolean().nullable().optional(),
  // Só depois do pagamento.
  total_amount: z.number().nullable().optional(),
  create_time: z.number().int(),
  update_time: z.number().int(),
  pay_time: z.number().int().nullable().optional(),
  shipping_carrier: z.string().nullable().optional(),
  payment_method: z.string().nullable().optional(),
  cancel_by: z.string().nullable().optional(),
  cancel_reason: z.string().nullable().optional(),
  /**
   * Quem expede o pedido (D-495): `fulfilled_by_shopee` (o armazém da Shopee),
   * `fulfilled_by_cb_seller` ou `fulfilled_by_local_seller` -- os valores da
   * documentação de `v2.order.get_order_detail`, lida em 19/10/2026. Texto como
   * veio: valor novo da Shopee não derruba a leitura.
   */
  fulfillment_flag: z.string().nullable().optional(),
  item_list: z.array(orderItemSchema).nullable().optional(),
});

export type ShopeeOrder = z.infer<typeof shopeeOrderSchema>;

const orderDetailSchema = z.object({
  response: z.object({ order_list: z.array(shopeeOrderSchema) }),
});

/** Os campos opcionais que a V3 usa — nada do comprador. */
const CAMPOS_DO_DETALHE = [
  "item_list",
  "total_amount",
  "pay_time",
  "shipping_carrier",
  "payment_method",
  "cancel_by",
  "cancel_reason",
  "fulfillment_flag",
].join(",");

/** O detalhe de até 50 pedidos. */
export async function getOrderDetail(
  client: ShopeeClient,
  shop: { accessToken: string; shopId: number },
  orderSns: readonly string[],
): Promise<ShopeeOrder[]> {
  if (orderSns.length === 0) return [];

  if (orderSns.length > ORDER_DETAIL_BATCH) {
    throw new Error(`get_order_detail aceita no máximo ${String(ORDER_DETAIL_BATCH)} pedidos por chamada`);
  }

  const resposta = await client.request({
    method: "GET",
    path: "/api/v2/order/get_order_detail",
    shop,
    query: { order_sn_list: orderSns.join(","), response_optional_fields: CAMPOS_DO_DETALHE },
    schema: orderDetailSchema,
  });

  return resposta.response.order_list;
}
