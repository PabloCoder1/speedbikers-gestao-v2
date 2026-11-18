import { simulateCoverageDays } from "../inventory/coverage-simulation.js";
import { demandWindowDays } from "./replenishment-policy.js";
import type { SkuReplenishmentVerdict } from "./sku-replenishment.js";
import { classifyMarginBand, type MarginBand, type MarginQuality } from "./sku-margin.js";

/**
 * A avaliação de compra de um SKU (D-721): "vale a pena comprar — e quanto?".
 *
 * Por cima do veredito de reposição (D-293: tendência, aproveitável, política,
 * sugestão e estado), junta o que a sugestão sozinha não vê:
 *
 * - **Giro contra estoque** — se o estoque já cobre a janela da política
 *   (prazo + cobertura + segurança), comprar mais é capital parado;
 * - **Idade comercial** — produto que começou a vender há pouco não tem
 *   histórico para ser julgado (nunca recomendar retirar só por vender pouco);
 * - **Ruptura no período** — dias sem estoque fazem a venda observada
 *   SUBESTIMAR a demanda; recomendação de retirada vira "revisar";
 * - **Margem** (D-720) contra o piso da organização (D-410);
 * - **Pedidos sobrepostos** — rascunhos e aprovados ainda fora do trânsito
 *   (o trânsito já está no aproveitável e não é contado de novo);
 * - **Descontinuado**, **MOQ** e **múltiplo de embalagem** do fornecedor.
 *
 * Tudo é determinístico e EXPLICÁVEL: a saída lista os motivos com os números
 * que os sustentam, e nenhum limiar é inventado aqui — vêm da política de
 * reposição (D-144), do piso de margem (D-410) e das preferências de compra
 * (`purchase_review_settings`). A decisão final é sempre do comprador: esta
 * peça recomenda, nunca altera pedido.
 */

export type PurchaseSituation =
  | "COMPRAR_AGORA"
  | "COMPRAR_EM_BREVE"
  | "ACOMPANHAR"
  | "COBERTO_POR_PEDIDOS"
  | "ESTOQUE_EM_EXCESSO"
  | "BAIXO_GIRO"
  | "MARGEM_INSUFICIENTE"
  | "REVISAR"
  | "PRODUTO_RECENTE"
  | "DADOS_INSUFICIENTES";

export type PurchaseRecommendation = "MANTER" | "REDUZIR" | "RETIRAR" | "REVISAR";

/**
 * Giro relativo ao estoque, pela régua da própria política:
 * ALTO = no ritmo atual o estoque NÃO cobre a janela de demanda (há sugestão);
 * BAIXO = o estoque já cobre a janela; PARADO = sem venda em 90 dias com
 * estoque positivo; INDEFINIDO = falta base para afirmar.
 */
export type TurnoverClass = "ALTO" | "BAIXO" | "PARADO" | "INDEFINIDO";

export type PurchaseReasonCode =
  | "RUPTURA_ATUAL"
  | "COBERTURA_ABAIXO_DO_PRAZO"
  | "ABAIXO_DO_PONTO_DE_PEDIDO"
  | "COBERTURA_JA_ATENDE"
  | "ACIMA_DA_SUGESTAO"
  | "ACIMA_DO_TETO"
  | "DEMANDA_EM_QUEDA"
  | "DEMANDA_CRESCENDO"
  | "SEM_VENDA_90D"
  | "MARGEM_NEGATIVA"
  | "MARGEM_ABAIXO_DO_MINIMO"
  | "MARGEM_DESCONHECIDA"
  | "MARGEM_ESTIMADA"
  | "PRODUTO_RECENTE"
  | "RUPTURA_NO_PERIODO"
  | "DISPONIBILIDADE_DESCONHECIDA"
  | "DESCONTINUADO"
  | "PEDIDO_SOBREPOSTO"
  | "ARREDONDADO_MOQ"
  | "ARREDONDADO_MULTIPLO"
  | "SEM_CONFIGURACAO"
  | "ESTOQUE_VIRTUAL"
  | "HISTORICO_INCOMPLETO"
  | "AMOSTRA_INSUFICIENTE";

export interface PurchaseReason {
  readonly code: PurchaseReasonCode;
  /** "atencao" pesa na decisão; "info" é contexto. */
  readonly weight: "atencao" | "info";
}

export interface PurchaseFitPreferences {
  /** Piso de margem da organização (fração), `central_thresholds.margin_floor`. */
  readonly marginFloor: number;
  /** Até quantos dias de vida comercial um SKU é "recente" (sem conclusão por pouca venda). */
  readonly newProductDays: number;
}

export interface PurchaseFitInput {
  readonly verdict: SkuReplenishmentVerdict;
  /** Unidades dos últimos 90 dias (todas as contas e lojas) — para "parado". */
  readonly units90d: number;
  /** Quantidade colocada no pedido em análise; nula fora de um pedido (tela de Reposição). */
  readonly orderedQuantity: number | null;
  /** Unidades em OUTROS pedidos abertos ainda fora do trânsito (rascunho/aprovado). */
  readonly otherOpenQuantity: number;
  /** Dias desde a 1ª venda observada; nulo = nunca vendeu. */
  readonly daysSinceFirstSale: number | null;
  /** Dias desde o cadastro do SKU — usado só quando ele nunca vendeu. */
  readonly daysSinceCreated: number | null;
  /** Dias dos últimos 30 em que o aproveitável ficou zerado; nulo = sem como saber. */
  readonly stockoutDays30: number | null;
  readonly isDiscontinued: boolean;
  readonly margin: number | null;
  readonly marginQuality: MarginQuality;
  /** Quantidade mínima do fornecedor para este SKU; nula = não cadastrada. */
  readonly minimumOrderQuantity: number | null;
  /** Múltiplo de embalagem; nulo ou 1 = unitário. */
  readonly packMultiple: number | null;
  readonly preferences: PurchaseFitPreferences;
}

export interface PurchaseFitResult {
  readonly situation: PurchaseSituation;
  /** Só dentro de um pedido (orderedQuantity não nulo). */
  readonly recommendation: PurchaseRecommendation | null;
  /**
   * Quanto o sistema compraria: a sugestão, descontados os pedidos sobrepostos
   * e ajustada ao MOQ e ao múltiplo. Nula quando não há base para número.
   */
  readonly recommendedQuantity: number | null;
  readonly turnover: TurnoverClass;
  readonly marginBand: MarginBand;
  readonly coverageDays: number | null;
  /** Cobertura depois de receber a quantidade do pedido; nula sem pedido ou sem taxa. */
  readonly coverageAfterOrderDays: number | null;
  readonly confidence: "ALTA" | "MEDIA" | "BAIXA";
  readonly reasons: readonly PurchaseReason[];
}

/** Arredonda para cima até o múltiplo e o mínimo — zero continua zero (não comprar). */
export function adjustToSupplierRules(
  quantity: number,
  minimumOrderQuantity: number | null,
  packMultiple: number | null,
): { quantity: number; moqApplied: boolean; multipleApplied: boolean } {
  if (quantity <= 0) return { quantity: 0, moqApplied: false, multipleApplied: false };

  let q = quantity;
  let moqApplied = false;
  let multipleApplied = false;

  if (minimumOrderQuantity !== null && minimumOrderQuantity > 0 && q < minimumOrderQuantity) {
    q = minimumOrderQuantity;
    moqApplied = true;
  }

  if (packMultiple !== null && packMultiple > 1 && q % packMultiple !== 0) {
    q = Math.ceil(q / packMultiple) * packMultiple;
    multipleApplied = true;
  }

  return { quantity: q, moqApplied, multipleApplied };
}

function coverageWith(stock: number | null, rate: number): number | null {
  if (stock === null || rate <= 0) return null;

  return simulateCoverageDays(Math.max(stock, 0), rate).coverageDays;
}

export function assessPurchaseFit(input: PurchaseFitInput): PurchaseFitResult {
  const { verdict, preferences } = input;
  const reasons: PurchaseReason[] = [];
  const add = (code: PurchaseReasonCode, weight: PurchaseReason["weight"] = "atencao"): void => {
    if (!reasons.some((r) => r.code === code)) reasons.push({ code, weight });
  };

  const usable = verdict.usable.total;
  const rate = verdict.trend.rateRecent;
  const policy = verdict.policy;
  const windowDays = policy === null ? null : demandWindowDays(policy);
  const coverageDays = verdict.stockState.coverageDays;
  const marginBand = classifyMarginBand(input.margin, preferences.marginFloor);

  // Idade comercial: a 1ª venda manda; sem venda nenhuma, o cadastro.
  const age = input.daysSinceFirstSale ?? input.daysSinceCreated;
  const isNew = age !== null && age < preferences.newProductDays;

  // Recusas da sugestão viram motivos (a linha diz por que não há número).
  for (const refusal of verdict.suggestion.refusals) add(refusal, "info");

  // ---- Giro --------------------------------------------------------------
  let turnover: TurnoverClass = "INDEFINIDO";

  if (usable !== null && usable > 0 && input.units90d === 0) {
    turnover = "PARADO";
  } else if (usable !== null && windowDays !== null && rate > 0) {
    // Com amostra pequena a taxa ainda divide: "cobre a janela" não depende da recusa de tendência.
    const cobre = coverageDays !== null && coverageDays >= windowDays;

    turnover = cobre ? "BAIXO" : "ALTO";
  }

  if (verdict.trend.trend === "CAINDO") add("DEMANDA_EM_QUEDA", turnover === "ALTO" ? "info" : "atencao");
  if (verdict.trend.trend === "CRESCENDO") add("DEMANDA_CRESCENDO", "info");
  if (turnover === "PARADO") add("SEM_VENDA_90D");

  // ---- Disponibilidade no período ---------------------------------------
  const hadStockout = input.stockoutDays30 !== null && input.stockoutDays30 > 0;

  if (hadStockout) add("RUPTURA_NO_PERIODO");
  if (input.stockoutDays30 === null) add("DISPONIBILIDADE_DESCONHECIDA", "info");

  // ---- Margem ------------------------------------------------------------
  if (marginBand === "NEGATIVA") add("MARGEM_NEGATIVA");
  if (marginBand === "ABAIXO_DO_MINIMO") add("MARGEM_ABAIXO_DO_MINIMO");
  if (marginBand === "DESCONHECIDA") add("MARGEM_DESCONHECIDA", "info");
  if (input.marginQuality === "ESTIMADA" || input.marginQuality === "PARCIAL") add("MARGEM_ESTIMADA", "info");

  if (input.isDiscontinued) add("DESCONTINUADO");
  if (isNew) add("PRODUTO_RECENTE", "info");

  // ---- Quantidade recomendada --------------------------------------------
  const suggested = verdict.suggestion.suggestedQuantity;
  let recommendedQuantity: number | null = null;

  if (suggested !== null) {
    const net = Math.max(0, suggested - Math.max(0, input.otherOpenQuantity));

    if (input.otherOpenQuantity > 0 && suggested > 0) add("PEDIDO_SOBREPOSTO", net === 0 ? "atencao" : "info");

    const adjusted = adjustToSupplierRules(net, input.minimumOrderQuantity, input.packMultiple);

    if (adjusted.moqApplied) add("ARREDONDADO_MOQ", "info");
    if (adjusted.multipleApplied) add("ARREDONDADO_MULTIPLO", "info");
    recommendedQuantity = input.isDiscontinued ? 0 : adjusted.quantity;
  } else if (!isNew && !input.isDiscontinued && usable !== null && windowDays !== null) {
    /*
      Sem sugestão por amostra pequena, mas com estoque e janela conhecidos: se
      o estoque já cobre a janela no ritmo observado (ou o SKU está parado), o
      número defensável é ZERO — é exatamente o caso do produto que vende pouco
      e tem estoque de sobra. Sem cobrir a janela, segue sem número.
    */
    const onlySample = verdict.suggestion.refusals.every((r) => r === "AMOSTRA_INSUFICIENTE");

    if (onlySample && (turnover === "BAIXO" || turnover === "PARADO")) recommendedQuantity = 0;
  } else if (input.isDiscontinued) {
    recommendedQuantity = 0;
  }

  if (suggested === 0 || (suggested === null && recommendedQuantity === 0 && !input.isDiscontinued)) {
    add("COBERTURA_JA_ATENDE");
  }

  // Estado operacional como motivo (o "por que comprar").
  const state = verdict.stockState.state;

  if (state === "RUPTURA") add("RUPTURA_ATUAL");
  if (state === "COMPRA_URGENTE") add("COBERTURA_ABAIXO_DO_PRAZO");
  if (state === "COMPRAR_EM_BREVE") add("ABAIXO_DO_PONTO_DE_PEDIDO", "info");

  // ---- Cobertura depois do pedido ----------------------------------------
  const ordered = input.orderedQuantity;
  const coverageAfterOrderDays =
    ordered === null || usable === null ? null : coverageWith(usable + ordered + Math.max(0, input.otherOpenQuantity), rate);

  if (
    ordered !== null &&
    policy?.maxCoverageDays !== null &&
    policy?.maxCoverageDays !== undefined &&
    coverageAfterOrderDays !== null &&
    coverageAfterOrderDays > policy.maxCoverageDays
  ) {
    add("ACIMA_DO_TETO");
  }

  // ---- Recomendação dentro do pedido -------------------------------------
  let recommendation: PurchaseRecommendation | null = null;

  if (ordered !== null && ordered > 0) {
    if (input.isDiscontinued) {
      recommendation = "RETIRAR";
    } else if (isNew) {
      // Produto recente nunca recebe "retirar" por vender pouco.
      recommendation = marginBand === "NEGATIVA" ? "REVISAR" : "MANTER";
    } else if (recommendedQuantity === null) {
      recommendation = marginBand === "NEGATIVA" ? "REVISAR" : null;
    } else if (recommendedQuantity === 0) {
      recommendation = "RETIRAR";
    } else if (ordered > recommendedQuantity) {
      recommendation = "REDUZIR";
      add("ACIMA_DA_SUGESTAO");
    } else {
      recommendation = "MANTER";
    }

    // Margem: negativa pede revisão; baixa com giro baixo reforça reduzir.
    if (marginBand === "NEGATIVA" && recommendation === "MANTER") recommendation = "REVISAR";

    // Ruptura no período: a venda observada pode estar subestimada — não afirmar retirada.
    if (hadStockout && (recommendation === "RETIRAR" || recommendation === "REDUZIR") && !input.isDiscontinued) {
      recommendation = "REVISAR";
    }
  }

  // ---- Situação (a mesma régua dentro e fora do pedido) -------------------
  const situation = situate({
    state,
    isNew,
    isDiscontinued: input.isDiscontinued,
    turnover,
    marginBand,
    suggested,
    recommendedQuantity,
    otherOpen: input.otherOpenQuantity,
    hadStockout,
    hasRefusals: verdict.suggestion.refusals.length > 0,
    trendFalling: verdict.trend.trend === "CAINDO",
  });

  // ---- Confiança ---------------------------------------------------------
  let confidence: PurchaseFitResult["confidence"] = "ALTA";

  if (verdict.suggestion.refusals.length > 0 || hadStockout || isNew) confidence = "BAIXA";
  else if (input.stockoutDays30 === null || input.marginQuality !== "CONFIAVEL") confidence = "MEDIA";

  return {
    situation,
    recommendation,
    recommendedQuantity,
    turnover,
    marginBand,
    coverageDays,
    coverageAfterOrderDays,
    confidence,
    reasons,
  };
}

function situate(f: {
  state: string | null;
  isNew: boolean;
  isDiscontinued: boolean;
  turnover: TurnoverClass;
  marginBand: MarginBand;
  suggested: number | null;
  recommendedQuantity: number | null;
  otherOpen: number;
  hadStockout: boolean;
  hasRefusals: boolean;
  trendFalling: boolean;
}): PurchaseSituation {
  const urgent = f.state === "RUPTURA" || f.state === "COMPRA_URGENTE";

  if (f.isDiscontinued) return "REVISAR";
  if (f.isNew) return "PRODUTO_RECENTE";
  if (f.suggested !== null && f.suggested > 0 && f.recommendedQuantity === 0 && f.otherOpen > 0) {
    return "COBERTO_POR_PEDIDOS";
  }
  if (f.marginBand === "NEGATIVA") return "MARGEM_INSUFICIENTE";
  if (f.state === "EXCESSO") return "ESTOQUE_EM_EXCESSO";
  if (f.turnover === "PARADO") return "BAIXO_GIRO";
  if (urgent) return "COMPRAR_AGORA";
  if (f.marginBand === "ABAIXO_DO_MINIMO" && f.turnover !== "ALTO") return "MARGEM_INSUFICIENTE";
  if (f.hasRefusals) {
    // Amostra pequena com estoque que já cobre a janela: é baixo giro, não falta de dado.
    if (f.recommendedQuantity === 0) return "BAIXO_GIRO";

    return "DADOS_INSUFICIENTES";
  }
  if (f.state === "COMPRAR_EM_BREVE" || f.state === "COBERTURA_BAIXA") {
    return f.marginBand === "ABAIXO_DO_MINIMO" ? "MARGEM_INSUFICIENTE" : "COMPRAR_EM_BREVE";
  }
  if (f.hadStockout) return "REVISAR";
  // O estoque cobre a janela E a venda cai: é o giro que não sustenta compra nova.
  if (f.turnover === "BAIXO" && f.trendFalling) return "BAIXO_GIRO";

  return "ACOMPANHAR";
}
