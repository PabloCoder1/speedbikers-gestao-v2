/**
 * As linhas do Excel da Curva ABC — puras, sem banco, para ter teste.
 *
 * A planilha traz as TRÊS curvas (faturamento, unidades, pedidos) do mesmo
 * recorte, e a aba consolidada junta, por SKU, o que cada curva disse dele.
 * Nada aqui agrega: cada número vem pronto da RPC (`get_sku_abc_curve`, que
 * calcula soma, participação e classe no Postgres); o que se faz por linha é
 * só razão entre dois números já dados (ticket médio, preço médio).
 */

export type AbcCriterionKey = "faturamento" | "unidades" | "pedidos";

export interface AbcCurveRow {
  sku_id: string;
  sku: string;
  title: string | null;
  metric_value: number;
  /** Pontos percentuais (12,34 = 12,34%), como a RPC devolve. */
  metric_share: number;
  cumulative_share: number;
  abc_class: "A" | "B" | "C";
  full_quantity: number;
  total_count: number;
  class_a_count: number;
  class_b_count: number;
  class_c_count: number;
  class_a_value: number;
  class_b_value: number;
  class_c_value: number;
  without_full_count: number;
}

export interface SkuExtra {
  supplierBrand: string | null;
  purchaseCost: number | null;
  localStock: number | null;
}

export interface CurveSummary {
  criterion: AbcCriterionKey;
  totalSkus: number;
  withoutFull: number;
  classes: readonly { classe: "A" | "B" | "C"; skus: number; valor: number; participacao: number | null }[];
}

export interface ConsolidatedRow {
  skuId: string;
  sku: string;
  title: string;
  brand: string | null;
  purchaseCost: number | null;
  localStock: number | null;
  fullStock: number;
  revenue: number | null;
  units: number | null;
  orders: number | null;
  classRevenue: "A" | "B" | "C" | null;
  classUnits: "A" | "B" | "C" | null;
  classOrders: "A" | "B" | "C" | null;
  /** "AAB" = A em faturamento, A em unidades, B em pedidos; "-" onde o SKU não entrou. */
  combinedClass: string;
  revenueShare: number | null;
  revenueCumulative: number | null;
  /** Faturamento ÷ pedidos. Sem pedido, vazio — nunca zero (D-067). */
  averageTicket: number | null;
  /** Faturamento ÷ unidades. */
  averageUnitPrice: number | null;
}

export function summarizeCurve(criterion: AbcCriterionKey, rows: readonly AbcCurveRow[]): CurveSummary {
  const first = rows[0];

  if (first === undefined) {
    return { criterion, totalSkus: 0, withoutFull: 0, classes: [] };
  }

  const total = first.class_a_value + first.class_b_value + first.class_c_value;
  const share = (valor: number): number | null => (total === 0 ? null : valor / total);

  return {
    criterion,
    totalSkus: first.total_count,
    withoutFull: first.without_full_count,
    classes: [
      { classe: "A", skus: first.class_a_count, valor: first.class_a_value, participacao: share(first.class_a_value) },
      { classe: "B", skus: first.class_b_count, valor: first.class_b_value, participacao: share(first.class_b_value) },
      { classe: "C", skus: first.class_c_count, valor: first.class_c_value, participacao: share(first.class_c_value) },
    ],
  };
}

const razao = (numerador: number | null, denominador: number | null): number | null =>
  numerador === null || denominador === null || denominador === 0 ? null : numerador / denominador;

/**
 * Uma linha por SKU que aparece em QUALQUER das três curvas, na ordem da curva
 * de faturamento (a padrão da tela); os que só entram por outra curva vêm
 * depois, na ordem dela.
 */
export function consolidateCurves(
  curves: Readonly<Record<AbcCriterionKey, readonly AbcCurveRow[]>>,
  extras: ReadonlyMap<string, SkuExtra>,
): ConsolidatedRow[] {
  const porCriterio = {
    faturamento: new Map(curves.faturamento.map((r) => [r.sku_id, r])),
    unidades: new Map(curves.unidades.map((r) => [r.sku_id, r])),
    pedidos: new Map(curves.pedidos.map((r) => [r.sku_id, r])),
  };

  const ordem: string[] = [];
  const visto = new Set<string>();

  for (const lista of [curves.faturamento, curves.unidades, curves.pedidos]) {
    for (const linha of lista) {
      if (!visto.has(linha.sku_id)) {
        visto.add(linha.sku_id);
        ordem.push(linha.sku_id);
      }
    }
  }

  return ordem.map((skuId) => {
    const f = porCriterio.faturamento.get(skuId);
    const u = porCriterio.unidades.get(skuId);
    const p = porCriterio.pedidos.get(skuId);
    const base = f ?? u ?? p;

    // Inalcançável: o id veio de uma das três listas.
    if (base === undefined) throw new Error(`SKU ${skuId} sem curva`);

    const extra = extras.get(skuId);

    const revenue = f?.metric_value ?? null;
    const units = u?.metric_value ?? null;
    const orders = p?.metric_value ?? null;

    return {
      skuId,
      sku: base.sku,
      title: base.title ?? "Produto sem título",
      brand: extra?.supplierBrand ?? null,
      purchaseCost: extra?.purchaseCost ?? null,
      localStock: extra?.localStock ?? null,
      fullStock: base.full_quantity,
      revenue,
      units,
      orders,
      classRevenue: f?.abc_class ?? null,
      classUnits: u?.abc_class ?? null,
      classOrders: p?.abc_class ?? null,
      combinedClass: `${f?.abc_class ?? "-"}${u?.abc_class ?? "-"}${p?.abc_class ?? "-"}`,
      revenueShare: f === undefined ? null : f.metric_share / 100,
      revenueCumulative: f === undefined ? null : f.cumulative_share / 100,
      averageTicket: razao(revenue, orders),
      averageUnitPrice: razao(revenue, units),
    };
  });
}

/** A frase do recorte, para o cabeçalho do arquivo e da aba Resumo. */
export function describeAbcExport(input: {
  days: number;
  dateFrom: string;
  dateTo: string;
  accountLabel: string | null;
  brand: string | null;
  onlyWithoutFull: boolean;
  formatDay: (day: string) => string;
}): string {
  const partes = [
    `últimos ${String(input.days)} dias (${input.formatDay(input.dateFrom)} a ${input.formatDay(input.dateTo)})`,
    input.accountLabel === null ? "todas as contas" : `conta ${input.accountLabel}`,
    input.brand === null ? "todas as marcas" : `marca ${input.brand}`,
  ];

  if (input.onlyWithoutFull) partes.push("somente SKUs sem estoque no Full");

  return partes.join(" · ");
}
