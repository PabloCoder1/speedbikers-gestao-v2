import { z } from "zod";

import type { ShopeeClient } from "./client.js";

/**
 * Devoluções (D-447) — `v2.returns.get_return_list`, conferida na referência
 * oficial em 14/10/2026 (e o guia "Return Refund Management").
 *
 * - A lista é por janela de `update_time` (ou `create_time`) de no máximo 15
 *   dias, até 100 por página, com `page_no` e `more`. A referência diz que
 *   `page_no` começa em 0 ("Default is 0"), mas o exemplo usa 1: a V3 começa
 *   em 0 e quem chama confere a repetição (a conferir no sandbox).
 * - Um pedido pode ter VÁRIAS devoluções (`return_sn` é o identificador).
 * - `status`: REQUESTED, ACCEPTED, CANCELLED, JUDGING, CLOSED, PROCESSING,
 *   SELLER_DISPUTE — a documentação não diz em qual o reembolso foi pago, e a
 *   V3 guarda como veio, sem interpretar.
 * - A V3 NÃO guarda o comprador (`user`: nome, e-mail e foto), as fotos da
 *   devolução nem o texto livre que o comprador escreveu: o schema abaixo
 *   descarta esses campos.
 */

/** A janela máxima de uma chamada da lista (documentação). */
export const RETURN_LIST_MAX_WINDOW_S = 15 * 24 * 3600;
export const RETURN_LIST_PAGE_SIZE = 100;

const valor = z.number().nullable().optional();
const texto = z.string().nullable().optional();
const inteiro = z.number().int().nullable().optional();
const booleano = z.boolean().nullable().optional();

const returnItemSchema = z.object({
  item_id: z.number().int(),
  model_id: inteiro,
  name: texto,
  amount: z.number().int().nonnegative(),
  item_price: valor,
  item_sku: texto,
  variation_sku: texto,
});

export const shopeeReturnSchema = z.object({
  return_sn: z.string().min(1),
  order_sn: z.string().min(1),
  status: z.string().min(1),
  reason: texto,
  reassessed_request_reason: texto,
  refund_amount: valor,
  amount_before_discount: valor,
  currency: texto,
  create_time: z.number().int(),
  update_time: z.number().int(),
  due_date: inteiro,
  return_ship_due_date: inteiro,
  return_seller_due_date: inteiro,
  tracking_number: texto,
  needs_logistics: booleano,
  negotiation_status: texto,
  seller_proof_status: texto,
  seller_compensation_status: texto,
  return_refund_type: texto,
  // 0: devolução e reembolso; 1: só reembolso (documentação).
  return_solution: inteiro,
  return_refund_request_type: inteiro,
  validation_type: texto,
  is_partial_quantity_return: booleano,
  is_refund_amount_adjusted: booleano,
  item: z.array(returnItemSchema).nullable().optional(),
});

export type ShopeeReturn = z.infer<typeof shopeeReturnSchema>;

const returnListSchema = z.object({
  response: z.object({
    more: z.boolean(),
    // Página vazia pode vir sem a lista.
    return: z.array(shopeeReturnSchema).nullable().optional(),
  }),
});

export interface ReturnListPage {
  returns: ShopeeReturn[];
  more: boolean;
}

/** Uma página de devoluções da janela de `update_time` (`timeFrom`/`timeTo` em epoch, segundos). */
export async function getReturnListPage(
  client: ShopeeClient,
  shop: { accessToken: string; shopId: number },
  options: { timeFrom: number; timeTo: number; pageNo: number },
): Promise<ReturnListPage> {
  const resposta = await client.request({
    method: "GET",
    path: "/api/v2/returns/get_return_list",
    shop,
    query: {
      page_no: String(options.pageNo),
      page_size: String(RETURN_LIST_PAGE_SIZE),
      update_time_from: String(options.timeFrom),
      update_time_to: String(options.timeTo),
    },
    schema: returnListSchema,
  });

  return { returns: resposta.response.return ?? [], more: resposta.response.more };
}
