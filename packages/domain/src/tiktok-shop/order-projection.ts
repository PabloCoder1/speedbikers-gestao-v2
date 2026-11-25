import { toSalesMetricDate } from "../metrics/business-date.js";

/**
 * Projeção de domínio de pedidos do TikTok Shop (D-809, `docs/TIKTOK_SHOP.md`
 * §6 e §13):
 *
 * - classifica os 9 status oficiais + divergência `CANCEL` do webhook;
 * - separa `ON_HOLD` (janela de arrependimento de 1 h) e `UNPAID` das vendas
 *   efetivamente pagas;
 * - classifica expedição (`FULFILLMENT_BY_SELLER` → `LOCAL`,
 *   `FULFILLMENT_BY_TIKTOK` → `FBT`, demais → `DESCONHECIDO`);
 * - projeta a data de negócio no fuso `America/Sao_Paulo` (D-050);
 * - agrega `line_items[]` (1 linha por unidade) em linhas por SKU/brinde,
 *   preservando componentes de bundle virtual (`combined_listing_skus`) e
 *   mantendo ausência de dado monetário como `null`;
 * - nunca armazena dados pessoais do comprador (`cpf`, endereço, e-mail).
 */

export const TIKTOK_FBT_FLAG = "FULFILLMENT_BY_TIKTOK";
export const TIKTOK_SELLER_FULFILLMENT_FLAG = "FULFILLMENT_BY_SELLER";

const MAX_UNIX_EPOCH_SECONDS = 8_640_000_000_000;

export type TikTokOrderLifecycle =
  | "PENDENTE_PAGAMENTO"
  | "JANELA_ARREPENDIMENTO"
  | "VALIDA"
  | "CANCELADA"
  | "DESCONHECIDO";

export type TikTokFulfillmentChannel = "LOCAL" | "FBT" | "DESCONHECIDO";

const STATUS_VALIDOS = new Set([
  "AWAITING_SHIPMENT",
  "PARTIALLY_SHIPPING",
  "AWAITING_COLLECTION",
  "IN_TRANSIT",
  "DELIVERED",
  "COMPLETED",
]);

/** Classifica o ciclo de vida operacional do pedido TikTok Shop, aceitando `CANCEL` e `CANCELLED`. */
export function classifyTikTokOrderLifecycle(status: string | null | undefined): TikTokOrderLifecycle {
  if (status === null || status === undefined) return "DESCONHECIDO";

  const normalizado = status.trim().toUpperCase();

  if (normalizado === "UNPAID") return "PENDENTE_PAGAMENTO";
  if (normalizado === "ON_HOLD") return "JANELA_ARREPENDIMENTO";
  if (normalizado === "CANCELLED" || normalizado === "CANCEL") return "CANCELADA";
  if (STATUS_VALIDOS.has(normalizado)) return "VALIDA";

  return "DESCONHECIDO";
}

/**
 * O pedido sai do centro do TikTok (`FULFILLMENT_BY_TIKTOK`)? Só a igualdade
 * exata: valor desconhecido ou ausente trata o pedido de forma conservadora
 * (mesma regra de `isArmazemDaShopee`, D-495).
 */
export function isTikTokFulfilledByPlatform(fulfillmentType: string | null | undefined): boolean {
  return fulfillmentType === TIKTOK_FBT_FLAG;
}

export interface TikTokCombinedSkuInput {
  readonly skuId?: string | null;
  readonly sellerSku?: string | null;
  readonly productId?: string | null;
  readonly skuCount?: number | null;
}

export interface TikTokLineItemInput {
  readonly id: string;
  readonly skuId?: string | null;
  readonly sellerSku?: string | null;
  readonly productId?: string | null;
  readonly salePrice?: string | number | null;
  readonly originalPrice?: string | number | null;
  readonly sellerDiscount?: string | number | null;
  readonly platformDiscount?: string | number | null;
  readonly isGift?: boolean | null;
  readonly combinedListingSkus?: readonly TikTokCombinedSkuInput[] | null;
}

export interface TikTokPaymentInput {
  readonly currency?: string | null;
  readonly subTotal?: string | number | null;
  readonly shippingFee?: string | number | null;
  readonly totalAmount?: string | number | null;
}

export interface TikTokOrderProjectionInput {
  readonly id: string;
  readonly status: string;
  /** Instante Unix em segundos. */
  readonly createTime: number;
  /** Instante Unix em segundos. */
  readonly updateTime: number;
  /** Instante Unix em segundos (ausente enquanto não pago). */
  readonly paidTime?: number | null;
  readonly fulfillmentType?: string | null;
  readonly shippingType?: string | null;
  readonly payment?: TikTokPaymentInput | null;
  readonly lineItems: readonly TikTokLineItemInput[];
}

export interface ProjectedTikTokCombinedSku {
  readonly skuId: string | null;
  readonly sellerSku: string | null;
  readonly productId: string | null;
  readonly skuCount: number | null;
}

export interface ProjectedTikTokOrderItem {
  readonly position: number;
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
  readonly combinedListingSkus: ProjectedTikTokCombinedSku[];
}

export interface ProjectedTikTokOrder {
  readonly orderId: string;
  readonly rawStatus: string;
  readonly lifecycle: TikTokOrderLifecycle;
  readonly fulfillmentChannel: TikTokFulfillmentChannel;
  readonly shippingType: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly paidAt: Date | null;
  /** Dia civil em `America/Sao_Paulo` ancorado em `paidAt` (ou `createdAt` se não pago). */
  readonly businessDate: string;
  readonly currency: string | null;
  readonly grossAmount: number | null;
  readonly subtotalAmount: number | null;
  readonly shippingFeeAmount: number | null;
  readonly totalUnits: number;
  readonly items: ProjectedTikTokOrderItem[];
}

function textoLimpo(valor: string | null | undefined): string | null {
  if (valor === null || valor === undefined) return null;

  const limpo = valor.trim();

  return limpo === "" ? null : limpo;
}

function epochParaDate(nome: string, segundos: number): Date {
  if (!Number.isSafeInteger(segundos) || segundos <= 0 || segundos > MAX_UNIX_EPOCH_SECONDS) {
    throw new RangeError(`projectTikTokOrder: ${nome} inválido (${String(segundos)})`);
  }

  return new Date(segundos * 1000);
}

export function parseDecimalOpcional(valor: string | number | null | undefined): number | null {
  if (valor === null || valor === undefined) return null;

  if (typeof valor === "number") {
    return Number.isFinite(valor) ? valor : null;
  }

  const limpo = valor.trim();

  if (!/^-?\d+(?:\.\d+)?$/.test(limpo)) return null;

  const numero = Number(limpo);

  return Number.isFinite(numero) ? numero : null;
}

function somarDecimal(acumulado: number | null, parcela: number | null): number | null {
  if (parcela === null) return acumulado;

  return Math.round(((acumulado ?? 0) + parcela) * 1_000_000) / 1_000_000;
}

function canalDeExpedicao(fulfillmentType: string | null | undefined): TikTokFulfillmentChannel {
  if (fulfillmentType === TIKTOK_FBT_FLAG) return "FBT";
  if (fulfillmentType === TIKTOK_SELLER_FULFILLMENT_FLAG) return "LOCAL";

  return "DESCONHECIDO";
}

export function projectTikTokOrder(input: TikTokOrderProjectionInput): ProjectedTikTokOrder {
  const orderId = textoLimpo(input.id);

  if (orderId === null) {
    throw new RangeError("projectTikTokOrder: identificador do pedido ausente");
  }

  const createdAt = epochParaDate("createTime", input.createTime);
  const updatedAt = epochParaDate("updateTime", input.updateTime);
  const paidAt =
    input.paidTime === null || input.paidTime === undefined ? null : epochParaDate("paidTime", input.paidTime);
  const businessDate = toSalesMetricDate(paidAt ?? createdAt);

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
      combinedByKey: Map<string, ProjectedTikTokCombinedSku>;
    }
  >();

  for (const item of input.lineItems) {
    const lineItemId = textoLimpo(item.id);

    if (lineItemId === null) continue;

    const skuId = textoLimpo(item.skuId);
    const sellerSku = textoLimpo(item.sellerSku);
    const productId = textoLimpo(item.productId);
    const isGift = item.isGift === true;
    const chave = `${skuId ?? ""}\u0000${sellerSku ?? ""}\u0000${productId ?? ""}\u0000${isGift ? "1" : "0"}`;

    let grupo = grupos.get(chave);

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
      grupos.set(chave, grupo);
    }

    grupo.quantity += 1;
    grupo.lineItemIds.push(lineItemId);
    grupo.salePriceTotal = somarDecimal(grupo.salePriceTotal, parseDecimalOpcional(item.salePrice));
    grupo.originalPriceTotal = somarDecimal(grupo.originalPriceTotal, parseDecimalOpcional(item.originalPrice));
    grupo.sellerDiscountTotal = somarDecimal(grupo.sellerDiscountTotal, parseDecimalOpcional(item.sellerDiscount));
    grupo.platformDiscountTotal = somarDecimal(grupo.platformDiscountTotal, parseDecimalOpcional(item.platformDiscount));

    for (const comp of item.combinedListingSkus ?? []) {
      const compSkuId = textoLimpo(comp.skuId);
      const compSellerSku = textoLimpo(comp.sellerSku);
      const compProductId = textoLimpo(comp.productId);
      const compCount =
        typeof comp.skuCount === "number" && Number.isSafeInteger(comp.skuCount) && comp.skuCount >= 0
          ? comp.skuCount
          : null;
      const compKey = `${compSkuId ?? ""}\u0000${compSellerSku ?? ""}\u0000${compProductId ?? ""}`;

      if (!grupo.combinedByKey.has(compKey)) {
        grupo.combinedByKey.set(compKey, {
          skuId: compSkuId,
          sellerSku: compSellerSku,
          productId: compProductId,
          skuCount: compCount,
        });
      }
    }
  }

  const items: ProjectedTikTokOrderItem[] = [...grupos.values()].map((grupo, position) => ({
    position,
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

  const totalUnits = items.reduce((acc, item) => acc + item.quantity, 0);

  return {
    orderId,
    rawStatus: input.status.trim(),
    lifecycle: classifyTikTokOrderLifecycle(input.status),
    fulfillmentChannel: canalDeExpedicao(input.fulfillmentType),
    shippingType: textoLimpo(input.shippingType),
    createdAt,
    updatedAt,
    paidAt,
    businessDate,
    currency: textoLimpo(input.payment?.currency)?.toUpperCase() ?? null,
    grossAmount: parseDecimalOpcional(input.payment?.totalAmount),
    subtotalAmount: parseDecimalOpcional(input.payment?.subTotal),
    shippingFeeAmount: parseDecimalOpcional(input.payment?.shippingFee),
    totalUnits,
    items,
  };
}
