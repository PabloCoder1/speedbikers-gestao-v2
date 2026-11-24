import { cancellationKeyOf } from "../inventory/reversal-limit.js";
import { fullEstornoOf, preCaptureEstornoOf } from "../inventory/sale-deduction.js";
import type { ErpCutoff, RecordedSale, StockMovementDraft } from "../inventory/sale-deduction.js";
import { classifyTikTokOrderLifecycle, isTikTokFulfilledByPlatform } from "./order-projection.js";

/**
 * Planejamento idempotente de baixa e reversão de estoque do TikTok Shop
 * (D-809, espelhando `shopee-sale-deduction.ts` D-495 e respeitando a guarda
 * D-497 de `docs/TIKTOK_SHOP.md` §13):
 *
 * - **Guarda D-497:** enquanto a venda do TikTok ainda entra pela NF-e
 *   (`orderDeductionEnabled === false`), nenhum movimento de venda/estorno é
 *   gerado, evitando baixa duplicada até o dono habilitar o corte do canal;
 * - **Janela de arrependimento (`ON_HOLD`, 1 h) e `UNPAID`:** não baixam
 *   estoque antes de o pedido virar venda efetiva ou cancelamento;
 * - **Corte da planilha UpSeller:** venda até `exportedAt` ganha
 *   `estornosPreCaptura`, e cancelamento até `exportedAt` não repõe de novo;
 * - **`FULFILLMENT_BY_TIKTOK` (FBT):** equivale ao Full/Armazém Shopee — ganha
 *   `estornosFbt` e o cancelamento não repõe estoque local.
 */

export interface TikTokSaleItem {
  readonly position: number;
  readonly quantity: number;
  readonly skuId: string | null;
  readonly skuKind: "PRODUTO" | "KIT" | null;
  /** Só relevante quando `skuKind === "KIT"`. */
  readonly components: readonly { componentSkuId: string; quantity: number }[];
}

export interface TikTokSaleOrder {
  /** `tiktok_shops.id` — entra na chave idempotente junto com `orderId`. */
  readonly shopId: string;
  readonly orderId: string;
  readonly status: string;
  /** Instante de pagamento (`paid_time`); nulo = não pago, nada a baixar. */
  readonly paidAt: Date | null;
  /** Instante da atualização/cancelamento (`cancel_time` ou `update_time`). */
  readonly updatedAt: Date;
  readonly fulfillmentType: string | null;
  /**
   * Guarda D-497: `true` somente quando o canal TikTok Shop estiver habilitado
   * para baixa pelo pedido (e a raiz do CNPJ do TikTok entrar na lista de
   * intermediadores ignorados na NF-e).
   */
  readonly orderDeductionEnabled: boolean;
  readonly items: readonly TikTokSaleItem[];
}

export interface TikTokStockInputs {
  readonly cutoffFor: (skuId: string) => ErpCutoff | null;
  readonly recordedSale: (idempotencyKey: string) => RecordedSale | undefined;
}

export interface TikTokStockMovements {
  readonly vendas: StockMovementDraft[];
  readonly estornosPreCaptura: StockMovementDraft[];
  readonly estornosFbt: StockMovementDraft[];
  readonly cancelamentos: StockMovementDraft[];
}

/** Chave idempotente: `tiktok-venda:<loja>:<order_id>:<posição>[:<componente>]`. */
export function tiktokSaleKeyOf(shopId: string, orderId: string, position: number, componentSkuId?: string): string {
  const base = `tiktok-venda:${shopId}:${orderId}:${String(position)}`;

  return componentSkuId === undefined ? base : `${base}:${componentSkuId}`;
}

const VAZIO: TikTokStockMovements = { vendas: [], estornosPreCaptura: [], estornosFbt: [], cancelamentos: [] };

export function computeTikTokStockMovements(order: TikTokSaleOrder, inputs: TikTokStockInputs): TikTokStockMovements {
  if (!order.orderDeductionEnabled) return VAZIO;
  if (order.paidAt === null) return VAZIO;

  const saleAt = order.paidAt;

  if (!Number.isFinite(saleAt.getTime())) {
    throw new RangeError(`computeTikTokStockMovements: paidAt inválido no pedido ${order.orderId}`);
  }

  const lifecycle = classifyTikTokOrderLifecycle(order.status);

  if (lifecycle === "PENDENTE_PAGAMENTO" || lifecycle === "JANELA_ARREPENDIMENTO") {
    return VAZIO;
  }

  const cancelado = lifecycle === "CANCELADA";

  if (cancelado && !Number.isFinite(order.updatedAt.getTime())) {
    throw new RangeError(`computeTikTokStockMovements: updatedAt inválido no pedido cancelado ${order.orderId}`);
  }

  const vendas: StockMovementDraft[] = [];

  for (const item of order.items) {
    if (item.skuId === null || !Number.isFinite(item.quantity) || item.quantity <= 0) continue;

    if (item.skuKind === "KIT") {
      for (const component of item.components) {
        if (!Number.isFinite(component.quantity) || component.quantity <= 0) continue;

        vendas.push({
          skuId: component.componentSkuId,
          qtyDelta: -(item.quantity * component.quantity),
          idempotencyKey: tiktokSaleKeyOf(order.shopId, order.orderId, item.position, component.componentSkuId),
          occurredAt: saleAt,
        });
      }

      continue;
    }

    vendas.push({
      skuId: item.skuId,
      qtyDelta: -item.quantity,
      idempotencyKey: tiktokSaleKeyOf(order.shopId, order.orderId, item.position),
      occurredAt: saleAt,
    });
  }

  const fbt = isTikTokFulfilledByPlatform(order.fulfillmentType);
  const precaptura = { cutoffFor: inputs.cutoffFor, recordedSale: inputs.recordedSale, recordedReversals: [] };
  const estornosPreCaptura: StockMovementDraft[] = [];
  const estornosFbt: StockMovementDraft[] = [];
  const cancelamentos: StockMovementDraft[] = [];

  for (const venda of vendas) {
    const doCorte = preCaptureEstornoOf(venda, saleAt, precaptura);

    if (doCorte !== null) {
      estornosPreCaptura.push(doCorte);
    } else if (fbt) {
      estornosFbt.push(fullEstornoOf(venda, inputs.recordedSale));
    }

    if (!cancelado || fbt) continue;

    const base = inputs.recordedSale(venda.idempotencyKey) ?? venda;
    const corte = inputs.cutoffFor(base.skuId);

    if (corte !== null && order.updatedAt.getTime() <= corte.exportedAt.getTime()) continue;

    cancelamentos.push({
      skuId: base.skuId,
      qtyDelta: -base.qtyDelta,
      idempotencyKey: cancellationKeyOf(venda.idempotencyKey),
      occurredAt: order.updatedAt,
    });
  }

  return { vendas, estornosPreCaptura, estornosFbt, cancelamentos };
}
