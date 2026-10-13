import { z } from "zod";

import { ShopeeApiError, type ShopeeClient } from "./client.js";

/**
 * Financeiro do pedido (D-427) — `v2.payment.get_escrow_detail`, conferido na
 * referência oficial em 13/10/2026: `GET`, um `order_sn` por chamada.
 *
 * - `order_income.escrow_amount` é o que a loja deve receber; **muda até o
 *   pedido completar** (frete real, devolução, ajuste).
 * - A Shopee manda 0 em muito campo que não se aplica: o 0 dela é guardado
 *   como veio. Campo AUSENTE fica nulo, nunca zero.
 * - `get_escrow_detail_batch` existe (até 50), mas a documentação se
 *   contradiz no formato da resposta (`response[]` no exemplo,
 *   `escrow_detail_list` com `fail_error` no erro): fica para depois de
 *   conferido no sandbox.
 * - Fora do `order_income` vêm `buyer_user_name` e `buyer_payment_info`: a V3
 *   não os guarda.
 */

const valor = z.number().nullable().optional();

/** Os campos que a V3 lê em coluna; o objeto inteiro fica guardado à parte. */
export const orderIncomeSchema = z
  .object({
    escrow_amount: valor,
    buyer_total_amount: valor,
    commission_fee: valor,
    service_fee: valor,
    seller_transaction_fee: valor,
    // Só para vendedor local no Brasil: a taxa depois do abatimento.
    net_commission_fee: valor,
    net_service_fee: valor,
    actual_shipping_fee: valor,
    buyer_paid_shipping_fee: valor,
    shopee_shipping_rebate: valor,
    final_shipping_fee: valor,
    reverse_shipping_fee: valor,
    seller_discount: valor,
    shopee_discount: valor,
    voucher_from_seller: valor,
    voucher_from_shopee: valor,
    order_ams_commission_fee: valor,
    seller_order_processing_fee: valor,
    total_adjustment_amount: valor,
    escrow_amount_after_adjustment: valor,
  })
  .loose();

export type ShopeeOrderIncome = z.infer<typeof orderIncomeSchema>;

const escrowDetailSchema = z.object({
  response: z.object({
    order_sn: z.string().min(1),
    return_order_sn_list: z.array(z.string()).nullable().optional(),
    order_income: orderIncomeSchema,
  }),
});

export interface ShopeeEscrowDetail {
  orderSn: string;
  returnOrderSns: string[];
  /** O `order_income` inteiro, como veio — sem nada do comprador. */
  orderIncome: ShopeeOrderIncome;
}

export async function getEscrowDetail(
  client: ShopeeClient,
  shop: { accessToken: string; shopId: number },
  orderSn: string,
): Promise<ShopeeEscrowDetail> {
  const resposta = await client.request({
    method: "GET",
    path: "/api/v2/payment/get_escrow_detail",
    shop,
    query: { order_sn: orderSn },
    schema: escrowDetailSchema,
  });

  return {
    orderSn: resposta.response.order_sn,
    returnOrderSns: resposta.response.return_order_sn_list ?? [],
    orderIncome: resposta.response.order_income,
  };
}

/**
 * Pedido sem financeiro para ler: a Shopee não acha o pedido (ainda não
 * pago, cancelado antes do pagamento) ou não tem o dado. Não é falha da
 * tarefa — o pedido fica sem financeiro até a próxima mudança dele.
 */
const SEM_FINANCEIRO = new Set(["order_not_found", "error_data", "common.error_not_found"]);

export function isEscrowUnavailable(error: unknown): boolean {
  return error instanceof ShopeeApiError && error.baseCode !== null && SEM_FINANCEIRO.has(error.baseCode);
}
