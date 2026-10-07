/**
 * As linhas do Excel da Curva ABC — puras, sem banco, para ter teste.
 *
 * Nada aqui agrega: soma, participação, classe, totais por classe e os
 * recortes por conta/marca/categoria/mês vêm prontos do Postgres
 * (`get_sku_abc_analysis`, `get_sku_abc_breakdown`). O que se faz por linha é
 * razão entre dois números já dados (ticket, preço médio, variação, valor do
 * estoque) e a junção das três curvas numa linha por SKU.
 */

export type AbcCriterionKey = "faturamento" | "unidades" | "pedidos";
export type AbcClassLetter = "A" | "B" | "C";
export type AbcDimension = "conta" | "marca" | "categoria" | "mes" | "migracao";

export interface AbcAnalysisRow {
  sku_id: string;
  sku: string;
  title: string | null;
  supplier_brand: string | null;
  category: string | null;
  kind: string;
  purchase_cost: number | null;
  revenue: number;
  units: number;
  orders: number;
  metric_value: number;
  /** Pontos percentuais (12,34 = 12,34%), como a RPC devolve. */
  metric_share: number;
  cumulative_share: number;
  abc_class: AbcClassLetter;
  class_revenue: AbcClassLetter | null;
  class_units: AbcClassLetter | null;
  class_orders: AbcClassLetter | null;
  prev_metric_value: number | null;
  prev_abc_class: AbcClassLetter | null;
  movement: string | null;
  local_stock: number | null;
  full_stock: number;
  coverage_days: number | null;
  total_count: number;
  class_a_count: number;
  class_b_count: number;
  class_c_count: number;
  class_a_value: number;
  class_b_value: number;
  class_c_value: number;
  without_full_count: number;
  total_revenue: number;
  total_units: number;
  total_orders: number;
  moved_up_count: number;
  moved_down_count: number;
  kept_count: number;
  new_count: number;
  scope_total_value: number;
  prev_scope_total_value: number | null;
}

export interface AbcBreakdownRow {
  group_key: string;
  group_label: string;
  revenue: number | null;
  units: number | null;
  orders: number | null;
  sku_count: number;
  class_a_value: number | null;
  class_b_value: number | null;
  class_c_value: number | null;
}

export interface SkuAccountSales {
  sku_id: string;
  ml_account_id: string;
  revenue: number;
  units: number;
  orders: number;
}

export interface CurveSummary {
  criterion: AbcCriterionKey;
  totalSkus: number;
  withoutFull: number;
  total: number;
  prevTotal: number | null;
  classes: readonly { classe: AbcClassLetter; skus: number; valor: number; participacao: number | null }[];
  movement: { subiu: number; caiu: number; manteve: number; novo: number };
}

export function summarizeCurve(criterion: AbcCriterionKey, rows: readonly AbcAnalysisRow[]): CurveSummary {
  const first = rows[0];

  if (first === undefined) {
    return {
      criterion,
      totalSkus: 0,
      withoutFull: 0,
      total: 0,
      prevTotal: null,
      classes: [],
      movement: { subiu: 0, caiu: 0, manteve: 0, novo: 0 },
    };
  }

  const total = first.class_a_value + first.class_b_value + first.class_c_value;
  const share = (valor: number): number | null => (total === 0 ? null : valor / total);

  return {
    criterion,
    totalSkus: first.total_count,
    withoutFull: first.without_full_count,
    total: first.scope_total_value,
    prevTotal: first.prev_scope_total_value,
    classes: [
      { classe: "A", skus: first.class_a_count, valor: first.class_a_value, participacao: share(first.class_a_value) },
      { classe: "B", skus: first.class_b_count, valor: first.class_b_value, participacao: share(first.class_b_value) },
      { classe: "C", skus: first.class_c_count, valor: first.class_c_value, participacao: share(first.class_c_value) },
    ],
    movement: {
      subiu: first.moved_up_count,
      caiu: first.moved_down_count,
      manteve: first.kept_count,
      novo: first.new_count,
    },
  };
}

export const razao = (numerador: number | null, denominador: number | null): number | null =>
  numerador === null || denominador === null || denominador === 0 ? null : numerador / denominador;

/** Variação contra o anterior; sem base anterior (ou base zero), nula -- nunca 0% fingido (D-067). */
export const variacao = (atual: number | null, anterior: number | null): number | null =>
  atual === null || anterior === null || anterior === 0 ? null : (atual - anterior) / anterior;

export interface ConsolidatedRow {
  skuId: string;
  sku: string;
  title: string;
  kind: string;
  brand: string | null;
  category: string | null;
  classRevenue: AbcClassLetter | null;
  classUnits: AbcClassLetter | null;
  classOrders: AbcClassLetter | null;
  /** "AAB" = A em faturamento, A em unidades, B em pedidos; "-" onde o SKU não entrou. */
  combinedClass: string;
  revenue: number;
  revenueShare: number | null;
  revenueCumulative: number | null;
  units: number;
  orders: number;
  /** Faturamento ÷ pedidos. Sem pedido, vazio — nunca zero (D-067). */
  averageTicket: number | null;
  /** Faturamento ÷ unidades. */
  averageUnitPrice: number | null;
  prevRevenue: number | null;
  revenueChange: number | null;
  prevClass: AbcClassLetter | null;
  movement: string | null;
  purchaseCost: number | null;
  localStock: number | null;
  fullStock: number;
  /** Estoque local (só o positivo) + Full; local não registrado deixa o total vazio. */
  totalStock: number | null;
  /** Custo unitário × estoque total. */
  stockValue: number | null;
  coverageDays: number | null;
}

const MOVIMENTO_TEXTO: Readonly<Record<string, string>> = {
  subiu: "Subiu",
  caiu: "Caiu",
  manteve: "Manteve",
  novo: "Novo",
};

export function movementLabel(movement: string | null): string | null {
  return movement === null ? null : (MOVIMENTO_TEXTO[movement] ?? movement);
}

/**
 * Uma linha por SKU que aparece em QUALQUER das três curvas, na ordem da curva
 * de faturamento (a padrão da tela); os que só entram por outra curva vêm
 * depois, na ordem dela. O período anterior é o do faturamento: só existe
 * para quem está na curva de faturamento.
 */
export function consolidateCurves(curves: Readonly<Record<AbcCriterionKey, readonly AbcAnalysisRow[]>>): ConsolidatedRow[] {
  const ordem: AbcAnalysisRow[] = [];
  const visto = new Set<string>();

  for (const lista of [curves.faturamento, curves.unidades, curves.pedidos]) {
    for (const linha of lista) {
      if (!visto.has(linha.sku_id)) {
        visto.add(linha.sku_id);
        ordem.push(linha);
      }
    }
  }

  const faturamento = new Map(curves.faturamento.map((r) => [r.sku_id, r]));

  return ordem.map((base) => {
    const f = faturamento.get(base.sku_id);
    const totalStock = base.local_stock === null ? null : Math.max(base.local_stock, 0) + Math.max(base.full_stock, 0);

    return {
      skuId: base.sku_id,
      sku: base.sku,
      title: base.title ?? "Produto sem título",
      kind: base.kind === "KIT" ? "Kit" : "Produto",
      brand: base.supplier_brand,
      category: base.category,
      classRevenue: base.class_revenue,
      classUnits: base.class_units,
      classOrders: base.class_orders,
      combinedClass: `${base.class_revenue ?? "-"}${base.class_units ?? "-"}${base.class_orders ?? "-"}`,
      revenue: base.revenue,
      revenueShare: f === undefined ? null : f.metric_share / 100,
      revenueCumulative: f === undefined ? null : f.cumulative_share / 100,
      units: base.units,
      orders: base.orders,
      averageTicket: razao(base.revenue, base.orders),
      averageUnitPrice: razao(base.revenue, base.units),
      prevRevenue: f?.prev_metric_value ?? null,
      revenueChange: f === undefined ? null : variacao(f.metric_value, f.prev_metric_value),
      prevClass: f?.prev_abc_class ?? null,
      movement: movementLabel(f?.movement ?? null),
      purchaseCost: base.purchase_cost,
      localStock: base.local_stock,
      fullStock: base.full_stock,
      totalStock,
      stockValue: base.purchase_cost === null || totalStock === null ? null : base.purchase_cost * totalStock,
      coverageDays: base.coverage_days,
    };
  });
}

export interface AccountColumn {
  id: string;
  label: string;
}

export interface AccountPivotRow {
  skuId: string;
  sku: string;
  title: string;
  classRevenue: AbcClassLetter | null;
  /** Total do SKU no recorte (da curva, não somado aqui). */
  revenue: number;
  units: number;
  /** Por conta, na ordem de `accounts`; sem venda na conta, nulo (célula vazia). */
  revenueByAccount: (number | null)[];
  unitsByAccount: (number | null)[];
}

/**
 * A venda de cada SKU em cada conta, lado a lado. É PIVÔ, não soma: cada par
 * (SKU, conta) já vem somado do banco, e o total da linha é o da curva.
 */
export function pivotByAccount(
  consolidated: readonly ConsolidatedRow[],
  sales: readonly SkuAccountSales[],
  accounts: readonly AccountColumn[],
): AccountPivotRow[] {
  const porSku = new Map<string, Map<string, SkuAccountSales>>();

  for (const venda of sales) {
    const contas = porSku.get(venda.sku_id) ?? new Map<string, SkuAccountSales>();
    contas.set(venda.ml_account_id, venda);
    porSku.set(venda.sku_id, contas);
  }

  return consolidated.map((linha) => {
    const contas = porSku.get(linha.skuId);

    return {
      skuId: linha.skuId,
      sku: linha.sku,
      title: linha.title,
      classRevenue: linha.classRevenue,
      revenue: linha.revenue,
      units: linha.units,
      revenueByAccount: accounts.map((a) => contas?.get(a.id)?.revenue ?? null),
      unitsByAccount: accounts.map((a) => contas?.get(a.id)?.units ?? null),
    };
  });
}

/** "2026-07" -> "jul/2026". */
export function monthLabel(key: string): string {
  const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const [ano, mes] = key.split("-");
  const indice = Number(mes) - 1;

  return ano === undefined || MESES[indice] === undefined ? key : `${MESES[indice]}/${ano}`;
}

export interface MigrationMatrix {
  /** Linhas: classe no período anterior ("A", "B", "C", "Novo"). */
  rows: readonly string[];
  /** Colunas: classe agora ("A", "B", "C", "Sem venda"). */
  columns: readonly string[];
  /** `cells[linha][coluna]`: quantos SKUs; o par que não aconteceu é 0 (é contagem, a ausência é zero de verdade). */
  cells: number[][];
}

export function migrationMatrix(rows: readonly AbcBreakdownRow[]): MigrationMatrix {
  const linhas = ["A", "B", "C", "Novo"];
  const colunas = ["A", "B", "C", "Sem venda"];
  const cells = linhas.map((de) =>
    colunas.map((para) => rows.find((r) => r.group_key === de && r.group_label === para)?.sku_count ?? 0),
  );

  return { rows: linhas, columns: colunas, cells };
}

/** A frase do recorte, para o cabeçalho de cada aba. */
export function describeAbcExport(input: {
  periodLabel: string;
  dateFrom: string;
  dateTo: string;
  prevFrom: string;
  prevTo: string;
  accountLabel: string | null;
  brand: string | null;
  category: string | null;
  kindLabel: string | null;
  onlyWithoutFull: boolean;
  formatDay: (day: string) => string;
}): string {
  const partes = [
    `${input.periodLabel} (${input.formatDay(input.dateFrom)} a ${input.formatDay(input.dateTo)})`,
    `comparado com ${input.formatDay(input.prevFrom)} a ${input.formatDay(input.prevTo)}`,
    input.accountLabel === null ? "todas as contas" : `conta ${input.accountLabel}`,
    input.brand === null ? "todas as marcas" : `marca ${input.brand}`,
    input.category === null ? "todas as categorias" : `categoria ${input.category}`,
    input.kindLabel === null ? "produtos e kits" : input.kindLabel.toLowerCase(),
  ];

  if (input.onlyWithoutFull) partes.push("somente SKUs sem estoque no Full");

  return partes.join(" · ");
}
