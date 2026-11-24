import type { ErpCutoff, StockMovementDraft } from "../inventory/sale-deduction.js";
import { toSalesMetricDate } from "../metrics/business-date.js";
import { isTikTokFulfilledByPlatform, parseDecimalOpcional } from "./order-projection.js";

/**
 * Projeção de devoluções e planejamento idempotente de reversão de estoque do
 * TikTok Shop (D-813, `M04`, `docs/TIKTOK_SHOP.md` §9 e §13):
 *
 * - normaliza a divergência `_CANCEL` (webhook) vs `_CANCELLED` (API);
 * - agrega `return_line_items[]` (1 entrada por unidade) sem reter PII;
 * - aplica guarda D-497 (`orderDeductionEnabled: false`), exige retorno físico
 *   (`RETURN_AND_REFUND` / `RETURN_OR_REFUND`) concluído, nunca repõe estoque
 *   local para `FULFILLMENT_BY_TIKTOK` (FBT) e respeita o limite físico de
 *   unidades vendidas menos cancelamentos/devoluções já gravados.
 */

export type TikTokReturnKind = "DEVOLUCAO_FISICA" | "APENAS_REEMBOLSO" | "CANCELAMENTO" | "DESCONHECIDO";

export interface TikTokReturnRefundAmountInput {
  readonly currency?: string | null;
  readonly refund_total?: string | null;
  readonly refund_subtotal?: string | null;
  readonly refund_shipping_fee?: string | null;
  readonly refund_tax?: string | null;
}

export interface TikTokReturnLineItemInput {
  readonly product_id?: string | null;
  readonly sku_id?: string | null;
  readonly seller_sku?: string | null;
}

export interface TikTokReturnProjectionInput {
  readonly return_id: string;
  readonly order_id: string;
  readonly return_type?: string | null;
  readonly return_status: string;
  readonly create_time?: number | null;
  readonly update_time?: number | null;
  readonly refund_amount?: TikTokReturnRefundAmountInput | null;
  readonly return_line_items?: readonly TikTokReturnLineItemInput[] | null;
}

export interface ProjectedTikTokReturnItem {
  readonly productId: string | null;
  readonly skuId: string | null;
  readonly sellerSku: string | null;
  readonly quantity: number;
}

export interface ProjectedTikTokReturn {
  readonly returnId: string;
  readonly orderId: string;
  readonly normalizedStatus: string;
  readonly kind: TikTokReturnKind;
  readonly completed: boolean;
  readonly businessDate: string | null;
  readonly createdAtIso: string | null;
  readonly updatedAtIso: string | null;
  readonly currency: string | null;
  readonly refundTotalBrl: number | null;
  readonly refundSubtotalBrl: number | null;
  readonly refundShippingBrl: number | null;
  readonly items: readonly ProjectedTikTokReturnItem[];
}

export interface TikTokRecordedSaleForReturn {
  readonly skuId: string;
  readonly qtyDelta: number;
  readonly idempotencyKey: string;
}

export interface TikTokRecordedReversalForReturn {
  readonly idempotencyKey: string;
  readonly qtyDelta: number;
}

export interface PlanTikTokReturnReversalInput {
  readonly returnId: string;
  readonly returnType: string | null | undefined;
  readonly returnStatus: string;
  readonly fulfillmentType: string | null;
  readonly orderDeductionEnabled: boolean;
  readonly occurredAt: Date;
  readonly returnedItems: readonly { readonly skuId: string; readonly quantity: number }[];
  readonly recordedSales: readonly TikTokRecordedSaleForReturn[];
  readonly recordedReversals: readonly TikTokRecordedReversalForReturn[];
  readonly estornadas: ReadonlySet<string>;
  readonly cutoffFor: (skuId: string) => ErpCutoff | null;
}

const MAX_UNIX_EPOCH_SECONDS = 8_640_000_000_000;
const TIKTOK_RETURN_PREFIX = "tiktok-devolucao:";
const CANCELAMENTO_PREFIX = "cancelamento:";

const RETURN_KIND_MAP: Readonly<Record<string, TikTokReturnKind>> = {
  RETURN_AND_REFUND: "DEVOLUCAO_FISICA",
  RETURN_OR_REFUND: "DEVOLUCAO_FISICA",
  REFUND_ONLY: "APENAS_REEMBOLSO",
  CANCEL: "CANCELAMENTO",
};

const COMPLETED_RETURN_STATUSES: ReadonlySet<string> = new Set([
  "RETURN_OR_REFUND_REQUEST_COMPLETE",
  "RETURN_OR_REFUND_COMPLETE",
  "REFUND_COMPLETE",
  "COMPLETED",
]);

export function normalizeTikTokReturnStatus(status: string): string {
  const trimmed = status.trim().toUpperCase();

  if (trimmed === "CANCEL") return "CANCELLED";
  if (trimmed.endsWith("_CANCEL")) return `${trimmed}LED`;

  return trimmed;
}

export function classifyTikTokReturnKind(returnType: string | null | undefined): TikTokReturnKind {
  if (typeof returnType !== "string") return "DESCONHECIDO";
  const key = returnType.trim().toUpperCase();

  return Object.hasOwn(RETURN_KIND_MAP, key) ? (RETURN_KIND_MAP[key] ?? "DESCONHECIDO") : "DESCONHECIDO";
}

export function isTikTokReturnCompleted(status: string): boolean {
  return COMPLETED_RETURN_STATUSES.has(normalizeTikTokReturnStatus(status));
}

/** Chave idempotente de devolução TikTok Shop: `tiktok-devolucao:<returnId>:<saleKey>`. */
export function tiktokReturnKeyOf(returnId: string, saleIdempotencyKey: string): string {
  const cleanReturnId = returnId.trim();
  const cleanSaleKey = saleIdempotencyKey.trim();

  if (cleanReturnId === "" || cleanSaleKey === "") {
    throw new RangeError("tiktokReturnKeyOf exige returnId e saleIdempotencyKey não vazios");
  }

  return `${TIKTOK_RETURN_PREFIX}${cleanReturnId}:${cleanSaleKey}`;
}

function textoOuNulo(valor: string | null | undefined): string | null {
  if (typeof valor !== "string") return null;
  const trimmed = valor.trim();

  return trimmed === "" ? null : trimmed;
}

function epochParaDate(epoch: number | null | undefined): Date | null {
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch <= 0 || epoch > MAX_UNIX_EPOCH_SECONDS) {
    return null;
  }

  return new Date(epoch * 1000);
}

function saleKeyFromReversal(reversalKey: string): string | null {
  if (reversalKey.startsWith(CANCELAMENTO_PREFIX)) {
    const rest = reversalKey.slice(CANCELAMENTO_PREFIX.length);

    return rest === "" ? null : rest;
  }

  if (reversalKey.startsWith(TIKTOK_RETURN_PREFIX)) {
    const rest = reversalKey.slice(TIKTOK_RETURN_PREFIX.length);
    const sep = rest.indexOf(":");

    if (sep > 0 && sep + 1 < rest.length) {
      return rest.slice(sep + 1);
    }
  }

  return null;
}

function arredonda3(valor: number): number {
  return Math.round(valor * 1000) / 1000;
}

export function projectTikTokReturn(input: TikTokReturnProjectionInput): ProjectedTikTokReturn {
  const returnId = input.return_id.trim();
  const orderId = input.order_id.trim();

  if (returnId === "" || orderId === "") {
    throw new RangeError("projectTikTokReturn exige return_id e order_id não vazios");
  }

  const normalizedStatus = normalizeTikTokReturnStatus(input.return_status);
  const kind = classifyTikTokReturnKind(input.return_type);
  const completed = isTikTokReturnCompleted(normalizedStatus);
  const createdAt = epochParaDate(input.create_time);
  const updatedAt = epochParaDate(input.update_time);
  const referenceDate = createdAt ?? updatedAt;

  const grouped = new Map<string, { productId: string | null; skuId: string | null; sellerSku: string | null; quantity: number }>();

  for (const line of input.return_line_items ?? []) {
    const productId = textoOuNulo(line.product_id);
    const skuId = textoOuNulo(line.sku_id);
    const sellerSku = textoOuNulo(line.seller_sku);
    const key = `${productId ?? ""}::${skuId ?? ""}::${sellerSku ?? ""}`;
    const existing = grouped.get(key);

    if (existing !== undefined) {
      existing.quantity += 1;
    } else {
      grouped.set(key, { productId, skuId, sellerSku, quantity: 1 });
    }
  }

  return {
    returnId,
    orderId,
    normalizedStatus,
    kind,
    completed,
    businessDate: referenceDate === null ? null : toSalesMetricDate(referenceDate),
    createdAtIso: createdAt === null ? null : createdAt.toISOString(),
    updatedAtIso: updatedAt === null ? null : updatedAt.toISOString(),
    currency: textoOuNulo(input.refund_amount?.currency),
    refundTotalBrl: parseDecimalOpcional(input.refund_amount?.refund_total),
    refundSubtotalBrl: parseDecimalOpcional(input.refund_amount?.refund_subtotal),
    refundShippingBrl: parseDecimalOpcional(input.refund_amount?.refund_shipping_fee),
    items: [...grouped.values()],
  };
}

/**
 * Planeja movimentos idempotentes de reposição por devolução física concluída
 * no TikTok Shop. Respeita D-497, FBT, corte do UpSeller e limite físico das
 * unidades efetivamente vendidas menos cancelamentos/devoluções anteriores.
 */
export function planTikTokReturnStockReversal(input: PlanTikTokReturnReversalInput): StockMovementDraft[] {
  const returnId = input.returnId.trim();

  if (returnId === "") {
    throw new RangeError("planTikTokReturnStockReversal: returnId obrigatório");
  }

  if (!Number.isFinite(input.occurredAt.getTime())) {
    throw new RangeError(`planTikTokReturnStockReversal: occurredAt inválido na devolução ${returnId}`);
  }

  if (!input.orderDeductionEnabled) return [];
  if (classifyTikTokReturnKind(input.returnType) !== "DEVOLUCAO_FISICA") return [];
  if (!isTikTokReturnCompleted(input.returnStatus)) return [];
  if (isTikTokFulfilledByPlatform(input.fulfillmentType)) return [];

  const drafts: StockMovementDraft[] = [];

  for (const item of input.returnedItems) {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) continue;

    const cutoff = input.cutoffFor(item.skuId);

    if (cutoff !== null && input.occurredAt.getTime() <= cutoff.exportedAt.getTime()) {
      continue;
    }

    let remainingWanted = arredonda3(item.quantity);

    for (const sale of input.recordedSales) {
      if (remainingWanted <= 0) break;
      if (sale.skuId !== item.skuId) continue;
      if (!Number.isFinite(sale.qtyDelta) || sale.qtyDelta >= 0) continue;
      if (input.estornadas.has(sale.idempotencyKey)) continue;

      const ownKey = tiktokReturnKeyOf(returnId, sale.idempotencyKey);
      let alreadyReversed = 0;

      for (const rev of input.recordedReversals) {
        if (rev.idempotencyKey === ownKey) continue;

        if (saleKeyFromReversal(rev.idempotencyKey) === sale.idempotencyKey) {
          if (!Number.isFinite(rev.qtyDelta) || rev.qtyDelta < 0) {
            throw new RangeError(
              `planTikTokReturnStockReversal: qtyDelta inválido na reversão ${rev.idempotencyKey}`,
            );
          }

          alreadyReversed = arredonda3(alreadyReversed + rev.qtyDelta);
        }
      }

      const reversible = Math.max(0, arredonda3(Math.abs(sale.qtyDelta) - alreadyReversed));

      if (reversible <= 0) continue;

      const toReverse = Math.min(remainingWanted, reversible);

      drafts.push({
        skuId: sale.skuId,
        qtyDelta: toReverse,
        idempotencyKey: ownKey,
        occurredAt: input.occurredAt,
      });
      remainingWanted = arredonda3(remainingWanted - toReverse);
    }
  }

  return drafts;
}
