/**
 * Margem por SKU entre marketplaces (D-720).
 *
 * A fórmula é a da casa, a mesma de `margem_venda` (5F) e de
 * `shopee_margem_venda` (5U):
 *
 *   margem = (recebido após taxas − custo do produto vendido) ÷ receita antes das taxas
 *
 * calculada SÓ sobre os pedidos **cobertos** de cada canal (frete/financeiro
 * observado, custo conhecido, um SKU por pedido). Os SOMATÓRIOS vêm do SQL
 * (`get_sku_margins`); esta peça só classifica e explica — nunca soma vendas.
 *
 * O consolidado entre canais é a razão das SOMAS, nunca a média das
 * porcentagens: um canal que vendeu R$ 100 com 50% e outro que vendeu
 * R$ 10.000 com 10% não dão 30%, dão ~10,4%. `consolidateSkuMargins` existe
 * para o teste de equivalência com o SQL e para o detalhe montado na tela a
 * partir das linhas por canal — a mesma conta dos dois lados.
 *
 * O que o "recebido" contém muda por canal, e isso é dito, não escondido:
 * - Mercado Livre: preço − comissão (`sale_fee`) − frete do vendedor. Taxa
 *   fixa, parcelamento, custo do Mercado Pago e impostos retidos ficam FORA
 *   (5C.1) — por isso o número do ML tende a ser OTIMISTA.
 * - Shopee: `escrow_amount` + ajustes depois do repasse (5U), que já descontam
 *   comissão, taxa de serviço e de transação, frete da loja e cupons.
 * - TikTok Shop: ainda não há pedidos nem financeiro lidos — a margem é
 *   INDISPONÍVEL, nunca zero.
 *
 * Nenhuma das três é lucro líquido contábil: imposto, Ads e custos fixos não
 * entram nesta margem.
 */

export type MarketplaceCode = "MERCADO_LIVRE" | "SHOPEE" | "TIKTOK_SHOP";

/** Os somatórios de UM recorte (canal, conta ou o consolidado) — como o SQL devolve. */
export interface SkuMarginTotals {
  /** Unidades de todas as vendas válidas do recorte (cobertas ou não). */
  readonly units: number;
  readonly orders: number;
  /** Receita bruta de todas as vendas válidas de receita conhecida. */
  readonly revenue: number;
  readonly coveredOrders: number;
  /** Receita, recebido e custo SÓ dos pedidos cobertos — o mesmo subconjunto nos três. */
  readonly coveredRevenue: number | null;
  readonly coveredReceived: number | null;
  readonly coveredCost: number | null;
  /** Pedidos cobertos cujo custo veio do cadastro ATUAL (sem histórico anterior à venda). */
  readonly currentCostOrders: number;
}

export type MarginQuality =
  /** ≥ 80% da receita coberta e todo custo histórico. */
  | "CONFIAVEL"
  /** Cobertura entre 0 e 80%: a margem vale para a parte coberta. */
  | "PARCIAL"
  /** Algum pedido coberto usou o custo atual no lugar do histórico. */
  | "ESTIMADA"
  /** Nenhum pedido coberto (ou nenhuma venda) — sem margem, nunca 0%. */
  | "INDISPONIVEL";

/**
 * O piso de cobertura para chamar a margem de confiável. Não é limiar de
 * compra: é o rótulo de QUALIDADE do número (D-720). Abaixo dele o número
 * aparece, mas com "parcial" e a fração ao lado.
 */
export const MARGIN_RELIABLE_COVERAGE = 0.8;

export interface SkuMarginResult {
  /** Fração (0,33 = 33%). Nula sem pedido coberto. */
  readonly margin: number | null;
  /** Receita coberta ÷ receita total; nula sem receita. */
  readonly coverage: number | null;
  readonly quality: MarginQuality;
  /** Resultado em reais do subconjunto coberto (recebido − custo). */
  readonly result: number | null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;

  return Math.round(value * factor) / factor;
}

export function evaluateSkuMargin(totals: SkuMarginTotals): SkuMarginResult {
  const coverage = totals.revenue > 0 && totals.coveredRevenue !== null ? round(totals.coveredRevenue / totals.revenue, 4) : null;

  if (
    totals.coveredOrders === 0 ||
    totals.coveredRevenue === null ||
    totals.coveredReceived === null ||
    totals.coveredCost === null ||
    totals.coveredRevenue <= 0
  ) {
    return { margin: null, coverage, quality: "INDISPONIVEL", result: null };
  }

  const result = round(totals.coveredReceived - totals.coveredCost, 2);
  const margin = round(result / totals.coveredRevenue, 4);

  let quality: MarginQuality = "CONFIAVEL";

  if (totals.currentCostOrders > 0) quality = "ESTIMADA";
  else if (coverage !== null && coverage < MARGIN_RELIABLE_COVERAGE) quality = "PARCIAL";

  return { margin, coverage, quality, result };
}

/**
 * Soma recortes e recalcula a margem sobre a soma — a ponderação financeira
 * que o SQL faz no consolidado. Recorte com `coveredRevenue` nulo entra só na
 * receita e nas unidades (ele não tem parte coberta).
 */
export function consolidateSkuMargins(parts: readonly SkuMarginTotals[]): SkuMarginTotals {
  let coveredRevenue: number | null = null;
  let coveredReceived: number | null = null;
  let coveredCost: number | null = null;

  for (const part of parts) {
    if (part.coveredOrders > 0 && part.coveredRevenue !== null && part.coveredReceived !== null && part.coveredCost !== null) {
      coveredRevenue = (coveredRevenue ?? 0) + part.coveredRevenue;
      coveredReceived = (coveredReceived ?? 0) + part.coveredReceived;
      coveredCost = (coveredCost ?? 0) + part.coveredCost;
    }
  }

  return {
    units: parts.reduce((s, p) => s + p.units, 0),
    orders: parts.reduce((s, p) => s + p.orders, 0),
    revenue: round(
      parts.reduce((s, p) => s + p.revenue, 0),
      2,
    ),
    coveredOrders: parts.reduce((s, p) => s + p.coveredOrders, 0),
    coveredRevenue: coveredRevenue === null ? null : round(coveredRevenue, 2),
    coveredReceived: coveredReceived === null ? null : round(coveredReceived, 2),
    coveredCost: coveredCost === null ? null : round(coveredCost, 2),
    currentCostOrders: parts.reduce((s, p) => s + p.currentCostOrders, 0),
  };
}

export type MarginBand = "NEGATIVA" | "ABAIXO_DO_MINIMO" | "SAUDAVEL" | "DESCONHECIDA";

/**
 * Faixa da margem contra o piso da organização (`central_thresholds.margin_floor`,
 * D-410 — o mesmo corte da Central e do Faturamento). Margem exatamente zero é
 * real e cai em "abaixo do mínimo" (quando o piso é positivo), nunca em
 * desconhecida.
 */
export function classifyMarginBand(margin: number | null, marginFloor: number): MarginBand {
  if (margin === null) return "DESCONHECIDA";
  if (margin < 0) return "NEGATIVA";
  if (margin < marginFloor) return "ABAIXO_DO_MINIMO";

  return "SAUDAVEL";
}

/**
 * Simulação da comissão do Mercado Livre por tipo de anúncio — referência
 * histórica da operação (Clássico 7%, Premium 17%), usada SÓ para projetar a
 * margem de uma compra futura quando não há recebido real. Nunca substitui a
 * taxa observada de uma venda.
 */
export const ML_LISTING_FEE_REFERENCE = { CLASSICO: 0.07, PREMIUM: 0.17 } as const;

export type MlListingTier = keyof typeof ML_LISTING_FEE_REFERENCE;

export interface ProjectedMarginInput {
  /** Preço de venda praticado (por unidade). */
  readonly unitPrice: number;
  /** Fração do preço que sobra depois das taxas, observada; nula = usar a simulação. */
  readonly observedReceivedRatio: number | null;
  /** Para a simulação quando não há razão observada. */
  readonly simulatedTier: MlListingTier | null;
  /** Custo unitário projetado da compra (com os custos de importação estimados, se houver). */
  readonly projectedUnitCost: number;
}

export interface ProjectedMargin {
  readonly margin: number | null;
  readonly basis: "OBSERVADA" | "SIMULADA" | "INDISPONIVEL";
}

/**
 * Margem projetada de uma compra: o recebido por unidade (observado quando a
 * venda real existe, simulado pela tarifa de referência quando não) contra o
 * custo projetado. Não substitui a margem histórica realizada — fica ao lado,
 * com a base declarada.
 */
export function projectPurchaseMargin(input: ProjectedMarginInput): ProjectedMargin {
  if (input.unitPrice <= 0 || input.projectedUnitCost < 0) return { margin: null, basis: "INDISPONIVEL" };

  if (input.observedReceivedRatio !== null) {
    const received = input.unitPrice * input.observedReceivedRatio;

    return { margin: round((received - input.projectedUnitCost) / input.unitPrice, 4), basis: "OBSERVADA" };
  }

  if (input.simulatedTier !== null) {
    const received = input.unitPrice * (1 - ML_LISTING_FEE_REFERENCE[input.simulatedTier]);

    return { margin: round((received - input.projectedUnitCost) / input.unitPrice, 4), basis: "SIMULADA" };
  }

  return { margin: null, basis: "INDISPONIVEL" };
}
