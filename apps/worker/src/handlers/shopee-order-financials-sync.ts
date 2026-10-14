import type { TablesUpdate } from "@sb/db";
import {
  ShopeeApiError,
  getEscrowDetail,
  isEscrowUnavailable,
  isShopLevelError,
  type ShopeeEscrowDetail,
} from "@sb/shopee";
import { ZodError } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { asJson } from "./domain-events.js";
import { falhaDaShopee, lerLojaConectada, type ShopeeJobDeps } from "./shopee-comum.js";
import { ensureShopeeAccessToken } from "./shopee-token.js";

/**
 * `shopee.order-financials.sync` (D-427) — o financeiro dos pedidos de UMA
 * loja Shopee: `get_escrow_detail`, um pedido por chamada, até 100 pedidos
 * por execução.
 *
 * - Quem precisa de leitura é o SQL que diz
 *   (`shopee_orders_financials_pending`): pago e nunca lido, alterado depois
 *   da última leitura, ou ainda aberto e lido há mais de 24 h.
 * - Pedido que a Shopee não acha fica marcado como lido, sem financeiro, e
 *   guarda a última leitura boa se havia uma — a próxima mudança dele o traz
 *   de volta.
 * - D-432: o erro DEFINITIVO de um pedido (parâmetro recusado, resposta fora
 *   do contrato) fica nele (`financials_error`) e a fila segue; ele volta em
 *   1 dia ou quando mudar. Antes, um pedido ruim voltava primeiro em toda
 *   execução e travava o financeiro da loja inteira. Só interrompem a tarefa
 *   o erro passageiro e o erro da LOJA (credencial, assinatura, loja
 *   inválida), que repetiria igual no próximo pedido.
 * - Lote cheio enfileira a continuação; o enfileiramento inicial vem de
 *   `shopee.orders.sync` quando os pedidos alcançam agora.
 */

export const FINANCEIRO_POR_EXECUCAO = 100;

export type ShopeeOrderFinancialsSyncDeps = ShopeeJobDeps;

/** As colunas de `shopee_orders` a partir do `order_income` — ausente vira nulo, nunca zero. */
function colunasDoFinanceiro(detalhe: ShopeeEscrowDetail, now: Date): TablesUpdate<"shopee_orders"> {
  const renda = detalhe.orderIncome;

  return {
    escrow_amount: renda.escrow_amount ?? null,
    buyer_total_amount: renda.buyer_total_amount ?? null,
    commission_fee: renda.commission_fee ?? null,
    service_fee: renda.service_fee ?? null,
    seller_transaction_fee: renda.seller_transaction_fee ?? null,
    net_commission_fee: renda.net_commission_fee ?? null,
    net_service_fee: renda.net_service_fee ?? null,
    actual_shipping_fee: renda.actual_shipping_fee ?? null,
    buyer_paid_shipping_fee: renda.buyer_paid_shipping_fee ?? null,
    shopee_shipping_rebate: renda.shopee_shipping_rebate ?? null,
    final_shipping_fee: renda.final_shipping_fee ?? null,
    reverse_shipping_fee: renda.reverse_shipping_fee ?? null,
    seller_discount: renda.seller_discount ?? null,
    shopee_discount: renda.shopee_discount ?? null,
    voucher_from_seller: renda.voucher_from_seller ?? null,
    voucher_from_shopee: renda.voucher_from_shopee ?? null,
    order_ams_commission_fee: renda.order_ams_commission_fee ?? null,
    seller_order_processing_fee: renda.seller_order_processing_fee ?? null,
    total_adjustment_amount: renda.total_adjustment_amount ?? null,
    escrow_amount_after_adjustment: renda.escrow_amount_after_adjustment ?? null,
    return_order_sns: detalhe.returnOrderSns,
    order_income: asJson(renda),
    financials_synced_at: now.toISOString(),
    financials_error: null,
    financials_error_at: null,
  };
}

/** Erro que vale para a loja inteira, ou que pede "tente depois": a tarefa para. */
function interrompe(error: unknown): boolean {
  if (error instanceof ZodError) return false;
  if (isShopLevelError(error)) return true;

  return !(error instanceof ShopeeApiError) || error.errorClass === "retryable";
}

/** O motivo gravado no pedido: o código da Shopee, nunca a mensagem com dados. */
function motivo(error: unknown): string {
  if (error instanceof ShopeeApiError) return error.code ?? `HTTP ${String(error.status)}`;

  return error instanceof ZodError ? "fora_do_contrato" : "erro";
}

export function createShopeeOrderFinancialsSyncHandler(deps: ShopeeOrderFinancialsSyncDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const aberta = await lerLojaConectada(deps, context, "shopee_order_financials_skipped");

    if ("outcome" in aberta) return aberta.outcome;

    const { loja } = aberta;
    const now = deps.now?.() ?? new Date();
    const pendentes = await deps.db.rpc("shopee_orders_financials_pending", {
      p_shopee_shop_id: loja.id,
      p_limit: FINANCEIRO_POR_EXECUCAO,
    });

    if (pendentes.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao listar pedidos sem financeiro: ${pendentes.error.message}` };
    }

    if (pendentes.data.length === 0) {
      return { status: "done", processed: 0 };
    }

    const token = await ensureShopeeAccessToken(deps, { id: loja.id, shopId: loja.shop_id }, now);

    if (!token.ok) {
      return { status: "failed", retryable: token.retryable, reason: token.reason };
    }

    const shop = { accessToken: token.accessToken, shopId: loja.shop_id };
    let lidos = 0;
    let semFinanceiro = 0;
    const recusados: { order_sn: string; motivo: string }[] = [];

    for (const { order_sn: orderSn } of pendentes.data) {
      let linha: TablesUpdate<"shopee_orders">;

      try {
        linha = colunasDoFinanceiro(await getEscrowDetail(deps.client, shop, orderSn), now);
        lidos += 1;
      } catch (error) {
        if (isEscrowUnavailable(error)) {
          linha = { financials_synced_at: now.toISOString(), financials_error: null, financials_error_at: null };
          semFinanceiro += 1;
        } else if (interrompe(error)) {
          // O que já foi gravado fica; a nova tentativa segue dos que faltam.
          return falhaDaShopee(error, "erro desconhecido ao ler o financeiro da Shopee");
        } else {
          // Recusa deste pedido: fica nele, e o financeiro guardado não muda.
          const porque = motivo(error);

          linha = { financials_error: porque.slice(0, 200), financials_error_at: now.toISOString() };
          recusados.push({ order_sn: orderSn, motivo: porque });
        }
      }

      const gravada = await deps.db
        .from("shopee_orders")
        .update(linha)
        .eq("shopee_shop_id", loja.id)
        .eq("order_sn", orderSn);

      if (gravada.error !== null) {
        return { status: "failed", retryable: true, reason: `falha ao gravar o financeiro do pedido: ${gravada.error.message}` };
      }
    }

    const temMais = pendentes.data.length === FINANCEIRO_POR_EXECUCAO;

    if (temMais) {
      await deps.enqueuer.enqueue({
        jobType: "shopee.order-financials.sync",
        organizationId: loja.organization_id,
        dedupeKey: `shopee-financials:${loja.id}:${String(Math.floor(now.getTime() / 1000))}`,
        queue: "backfill",
        payload: { shopeeShopId: loja.id },
      });
    }

    context.logger.info("shopee_order_financials_done", {
      shopee_shop_id: loja.id,
      shop_id: loja.shop_id,
      pedidos_pendentes: pendentes.data.length,
      financeiros_lidos: lidos,
      sem_financeiro: semFinanceiro,
      recusados: recusados.length,
      tem_mais: temMais,
    });

    if (recusados.length > 0) {
      context.logger.warn("shopee_order_financials_refused", {
        shopee_shop_id: loja.id,
        pedidos: recusados.slice(0, 20),
      });
    }

    return { status: "done", processed: lidos + semFinanceiro + recusados.length };
  };
}
