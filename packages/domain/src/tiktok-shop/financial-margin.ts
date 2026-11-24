import { parseDecimalOpcional } from "./order-projection.js";

/**
 * Margem financeira do TikTok Shop (D-809) — fórmula oficial da V3:
 *
 *   Margem (%) = ((Recebido após taxas − Custo do produto vendido) / Valor bruto da venda) × 100
 *
 * - Consolidado = soma dos resultados ÷ soma dos valores brutos × 100 (nunca
 *   média simples de percentuais);
 * - preserva a distinção `REALIZADO` (extrato/transação `202501` liquidado)
 *   vs `ESTIMADO` (pedido não liquidado `202507`);
 * - ausência de custo, ausência de financeiro ou valor bruto <= 0 devolvem
 *   `marginPct = null` e `covered = false` — nunca zero inventado.
 */

export type TikTokMarginBasis = "REALIZADO" | "ESTIMADO";

export type TikTokMarginMissingReason = "valor_bruto_invalido" | "financeiro_ausente" | "custo_ausente";

export interface TikTokMarginCostItem {
  readonly quantity: number;
  /** Custo unitário do SKU; `null` = custo desconhecido (nunca vira zero). */
  readonly unitCost: number | null;
}

export interface TikTokOrderMarginInput {
  readonly orderId: string;
  readonly basis: TikTokMarginBasis;
  readonly grossAmount: string | number | null | undefined;
  readonly netReceivedAmount: string | number | null | undefined;
  readonly feeAndTaxAmount?: string | number | null | undefined;
  readonly feePerItemSoldAmount?: string | number | null | undefined;
  readonly shippingCostAmount?: string | number | null | undefined;
  readonly items: readonly TikTokMarginCostItem[];
}

export interface TikTokOrderMarginEvaluation {
  readonly orderId: string;
  readonly basis: TikTokMarginBasis;
  readonly grossAmount: number | null;
  readonly netReceivedAmount: number | null;
  readonly feeAndTaxAmount: number | null;
  readonly feePerItemSoldAmount: number | null;
  readonly shippingCostAmount: number | null;
  readonly cogsAmount: number | null;
  readonly profitAmount: number | null;
  readonly marginPct: number | null;
  readonly covered: boolean;
  readonly missingReason: TikTokMarginMissingReason | null;
}

export interface TikTokConsolidatedMargin {
  readonly totalOrders: number;
  readonly coveredOrders: number;
  readonly realizedOrders: number;
  readonly estimatedOrders: number;
  readonly missingCostOrders: number;
  readonly missingFinancialOrders: number;
  readonly coveredGrossAmount: number;
  readonly coveredNetReceivedAmount: number;
  readonly coveredCogsAmount: number;
  readonly coveredProfitAmount: number;
  readonly consolidatedMarginPct: number | null;
}

function arredondar(valor: number, casas = 2): number {
  const fator = 10 ** casas;

  return Math.round(valor * fator) / fator;
}

function calcularCpv(items: readonly TikTokMarginCostItem[]): number | null {
  if (items.length === 0) return null;

  let total = 0;

  for (const item of items) {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) return null;
    if (item.unitCost === null || !Number.isFinite(item.unitCost) || item.unitCost < 0) return null;

    total += item.quantity * item.unitCost;
  }

  return Number.isFinite(total) ? arredondar(total, 6) : null;
}

export function evaluateTikTokOrderMargin(input: TikTokOrderMarginInput): TikTokOrderMarginEvaluation {
  const grossAmount = parseDecimalOpcional(input.grossAmount);
  const netReceivedAmount = parseDecimalOpcional(input.netReceivedAmount);
  const feeAndTaxAmount = parseDecimalOpcional(input.feeAndTaxAmount);
  const feePerItemSoldAmount = parseDecimalOpcional(input.feePerItemSoldAmount);
  const shippingCostAmount = parseDecimalOpcional(input.shippingCostAmount);
  const cogsAmount = calcularCpv(input.items);

  if (grossAmount === null || grossAmount <= 0) {
    return {
      orderId: input.orderId,
      basis: input.basis,
      grossAmount,
      netReceivedAmount,
      feeAndTaxAmount,
      feePerItemSoldAmount,
      shippingCostAmount,
      cogsAmount,
      profitAmount: null,
      marginPct: null,
      covered: false,
      missingReason: "valor_bruto_invalido",
    };
  }

  if (netReceivedAmount === null) {
    return {
      orderId: input.orderId,
      basis: input.basis,
      grossAmount,
      netReceivedAmount: null,
      feeAndTaxAmount,
      feePerItemSoldAmount,
      shippingCostAmount,
      cogsAmount,
      profitAmount: null,
      marginPct: null,
      covered: false,
      missingReason: "financeiro_ausente",
    };
  }

  if (cogsAmount === null) {
    return {
      orderId: input.orderId,
      basis: input.basis,
      grossAmount,
      netReceivedAmount,
      feeAndTaxAmount,
      feePerItemSoldAmount,
      shippingCostAmount,
      cogsAmount: null,
      profitAmount: null,
      marginPct: null,
      covered: false,
      missingReason: "custo_ausente",
    };
  }

  const profitAmount = arredondar(netReceivedAmount - cogsAmount, 6);
  const marginPct = arredondar((profitAmount / grossAmount) * 100, 2);

  return {
    orderId: input.orderId,
    basis: input.basis,
    grossAmount,
    netReceivedAmount,
    feeAndTaxAmount,
    feePerItemSoldAmount,
    shippingCostAmount,
    cogsAmount,
    profitAmount,
    marginPct,
    covered: true,
    missingReason: null,
  };
}

/**
 * Consolida a margem ponderada sobre os pedidos cobertos:
 * `sum(profitAmount) / sum(grossAmount) * 100`. Sem pedidos cobertos, devolve `null`.
 */
export function consolidateTikTokMargins(entries: readonly TikTokOrderMarginEvaluation[]): TikTokConsolidatedMargin {
  let coveredOrders = 0;
  let realizedOrders = 0;
  let estimatedOrders = 0;
  let missingCostOrders = 0;
  let missingFinancialOrders = 0;
  let coveredGrossAmount = 0;
  let coveredNetReceivedAmount = 0;
  let coveredCogsAmount = 0;
  let coveredProfitAmount = 0;

  for (const entry of entries) {
    if (!entry.covered || entry.grossAmount === null || entry.netReceivedAmount === null || entry.cogsAmount === null || entry.profitAmount === null) {
      if (entry.missingReason === "custo_ausente") missingCostOrders += 1;
      if (entry.missingReason === "financeiro_ausente") missingFinancialOrders += 1;

      continue;
    }

    coveredOrders += 1;

    if (entry.basis === "REALIZADO") {
      realizedOrders += 1;
    } else {
      estimatedOrders += 1;
    }

    coveredGrossAmount += entry.grossAmount;
    coveredNetReceivedAmount += entry.netReceivedAmount;
    coveredCogsAmount += entry.cogsAmount;
    coveredProfitAmount += entry.profitAmount;
  }

  const grossRounded = arredondar(coveredGrossAmount, 6);
  const netRounded = arredondar(coveredNetReceivedAmount, 6);
  const cogsRounded = arredondar(coveredCogsAmount, 6);
  const profitRounded = arredondar(coveredProfitAmount, 6);
  const consolidatedMarginPct =
    coveredOrders > 0 && grossRounded > 0 ? arredondar((profitRounded / grossRounded) * 100, 2) : null;

  return {
    totalOrders: entries.length,
    coveredOrders,
    realizedOrders,
    estimatedOrders,
    missingCostOrders,
    missingFinancialOrders,
    coveredGrossAmount: grossRounded,
    coveredNetReceivedAmount: netRounded,
    coveredCogsAmount: cogsRounded,
    coveredProfitAmount: profitRounded,
    consolidatedMarginPct,
  };
}
