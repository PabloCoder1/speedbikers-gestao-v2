import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  consolidateCurves,
  describeAbcExport,
  migrationMatrix,
  monthLabel,
  pivotByAccount,
  summarizeCurve,
  type AbcAnalysisRow,
  type AbcBreakdownRow,
} from "./rows";
import { buildAbcWorkbook } from "./workbook";

export function linha(sku: string, metric: number, classe: "A" | "B" | "C", extra: Partial<AbcAnalysisRow> = {}): AbcAnalysisRow {
  return {
    sku_id: `id-${sku}`,
    sku,
    title: `Produto ${sku}`,
    supplier_brand: "OFF RACER",
    category: "MANETE",
    kind: "PRODUTO",
    purchase_cost: 40,
    revenue: 800,
    units: 10,
    orders: 8,
    metric_value: metric,
    metric_share: 50,
    cumulative_share: 50,
    abc_class: classe,
    class_revenue: classe,
    class_units: "B",
    class_orders: "A",
    prev_metric_value: 400,
    prev_abc_class: "B",
    movement: "subiu",
    local_stock: 12,
    full_stock: 3,
    coverage_days: 45.5,
    total_count: 2,
    class_a_count: 1,
    class_b_count: 1,
    class_c_count: 0,
    class_a_value: 800,
    class_b_value: 200,
    class_c_value: 0,
    without_full_count: 1,
    total_revenue: 1000,
    total_units: 40,
    total_orders: 12,
    moved_up_count: 1,
    moved_down_count: 0,
    kept_count: 1,
    new_count: 0,
    scope_total_value: 1000,
    prev_scope_total_value: 800,
    ...extra,
  };
}

describe("consolidateCurves", () => {
  it("junta as três curvas por SKU, na ordem do faturamento, e os de fora no fim", () => {
    const linhas = consolidateCurves({
      faturamento: [linha("X", 800, "A"), linha("Y", 200, "B")],
      unidades: [linha("Y", 30, "A"), linha("X", 10, "B"), linha("Z", 5, "C")],
      pedidos: [linha("X", 8, "A"), linha("Y", 4, "B")],
    });

    expect(linhas.map((l) => l.sku)).toEqual(["X", "Y", "Z"]);
    expect(linhas[0]).toMatchObject({
      brand: "OFF RACER",
      category: "MANETE",
      kind: "Produto",
      purchaseCost: 40,
      localStock: 12,
      fullStock: 3,
      totalStock: 15,
      stockValue: 600,
      revenue: 800,
      units: 10,
      orders: 8,
      combinedClass: "ABA",
      averageTicket: 100,
      averageUnitPrice: 80,
      revenueShare: 0.5,
      prevRevenue: 400,
      revenueChange: 1,
      prevClass: "B",
      movement: "Subiu",
      coverageDays: 45.5,
    });
  });

  it("SKU fora da curva de faturamento: sem participação nem período anterior, e nada vira zero", () => {
    const [z] = consolidateCurves({
      faturamento: [],
      unidades: [linha("Z", 5, "C", { class_revenue: null, local_stock: null, purchase_cost: null })],
      pedidos: [],
    });

    expect(z).toMatchObject({
      revenueShare: null,
      revenueCumulative: null,
      prevRevenue: null,
      revenueChange: null,
      movement: null,
      totalStock: null,
      stockValue: null,
      combinedClass: "-BA",
    });
  });

  it("sem pedido, o ticket fica vazio; sem base anterior, a variação também", () => {
    const [x] = consolidateCurves({
      faturamento: [linha("X", 800, "A", { orders: 0, prev_metric_value: null, movement: "novo" })],
      unidades: [],
      pedidos: [],
    });

    expect(x?.averageTicket).toBeNull();
    expect(x?.revenueChange).toBeNull();
    expect(x?.movement).toBe("Novo");
  });
});

describe("summarizeCurve", () => {
  it("lê classes, totais e movimento das janelas da primeira linha", () => {
    const s = summarizeCurve("faturamento", [linha("X", 800, "A"), linha("Y", 200, "B")]);

    expect(s.totalSkus).toBe(2);
    expect(s.total).toBe(1000);
    expect(s.prevTotal).toBe(800);
    expect(s.classes.map((c) => [c.classe, c.skus, c.valor, c.participacao])).toEqual([
      ["A", 1, 800, 0.8],
      ["B", 1, 200, 0.2],
      ["C", 0, 0, 0],
    ]);
    expect(s.movement).toEqual({ subiu: 1, caiu: 0, manteve: 1, novo: 0 });
  });

  it("curva vazia é resposta, não erro", () => {
    expect(summarizeCurve("pedidos", [])).toMatchObject({ totalSkus: 0, classes: [], prevTotal: null });
  });
});

describe("pivotByAccount", () => {
  it("põe a venda de cada conta lado a lado; conta sem venda fica vazia", () => {
    const consolidado = consolidateCurves({ faturamento: [linha("20017", 60_000, "A")], unidades: [], pedidos: [] });
    const [p] = pivotByAccount(
      consolidado,
      [
        { sku_id: "id-20017", ml_account_id: "c1", revenue: 40_000, units: 300, orders: 280 },
        { sku_id: "id-20017", ml_account_id: "c3", revenue: 20_000, units: 150, orders: 140 },
      ],
      [
        { id: "c1", label: "Loja 1" },
        { id: "c2", label: "Loja 2" },
        { id: "c3", label: "GMR" },
      ],
    );

    expect(p?.revenueByAccount).toEqual([40_000, null, 20_000]);
    expect(p?.unitsByAccount).toEqual([300, null, 150]);
  });
});

describe("migração e rótulos", () => {
  it("monta a matriz antes x agora; par que não aconteceu é zero de contagem", () => {
    const linhas: AbcBreakdownRow[] = [
      { group_key: "A", group_label: "A", sku_count: 10, revenue: null, units: null, orders: null, class_a_value: null, class_b_value: null, class_c_value: null },
      { group_key: "B", group_label: "A", sku_count: 3, revenue: null, units: null, orders: null, class_a_value: null, class_b_value: null, class_c_value: null },
      { group_key: "Novo", group_label: "C", sku_count: 7, revenue: null, units: null, orders: null, class_a_value: null, class_b_value: null, class_c_value: null },
      { group_key: "C", group_label: "Sem venda", sku_count: 4, revenue: null, units: null, orders: null, class_a_value: null, class_b_value: null, class_c_value: null },
    ];
    const m = migrationMatrix(linhas);

    expect(m.cells).toEqual([
      [10, 0, 0, 0],
      [3, 0, 0, 0],
      [0, 0, 0, 4],
      [0, 0, 7, 0],
    ]);
  });

  it("mês vira rótulo curto", () => {
    expect(monthLabel("2026-07")).toBe("jul/2026");
    expect(monthLabel("lixo")).toBe("lixo");
  });

  it("a frase do recorte diz período, comparação e cada recorte", () => {
    const frase = describeAbcExport({
      periodLabel: "últimos 90 dias",
      dateFrom: "2026-07-10",
      dateTo: "2026-10-07",
      prevFrom: "2026-04-11",
      prevTo: "2026-07-09",
      accountLabel: null,
      brand: "OFF RACER",
      category: null,
      kindLabel: "Kits",
      onlyWithoutFull: true,
      formatDay: (d) => d,
    });

    expect(frase).toBe(
      "últimos 90 dias (2026-07-10 a 2026-10-07) · comparado com 2026-04-11 a 2026-07-09 · todas as contas · marca OFF RACER · todas as categorias · kits · somente SKUs sem estoque no Full",
    );
  });
});

describe("buildAbcWorkbook", () => {
  const vazio = { faturamento: [], unidades: [], pedidos: [] };
  const recortes = { conta: [], marca: [], categoria: [], mes: [], migracao: [] };

  it("gera as abas e os oito gráficos nativos do painel, ligados à aba Painel", async () => {
    const curva = [linha("X", 800, "A"), linha("Y", 200, "B")];
    const porMes: AbcBreakdownRow = {
      group_key: "2026-07",
      group_label: "2026-07",
      revenue: 1000,
      units: 40,
      orders: 12,
      sku_count: 2,
      class_a_value: 800,
      class_b_value: 200,
      class_c_value: 0,
    };
    const arquivo = await buildAbcWorkbook({
      curves: { faturamento: curva, unidades: curva, pedidos: curva },
      breakdowns: { ...recortes, conta: [{ ...porMes, group_key: "c1", group_label: "Loja 1" }], mes: [porMes], marca: [porMes], categoria: [porMes] },
      byAccount: [],
      accounts: [{ id: "c1", label: "Loja 1" }],
      organizationName: "Speed Bikers",
      recorte: "teste",
      dayCount: 90,
      generatedAt: new Date("2026-10-07T12:00:00Z"),
    });
    const zip = await JSZip.loadAsync(arquivo);
    const graficos = Object.keys(zip.files).filter((f) => /^xl\/charts\/chart\d+\.xml$/.test(f));
    const workbook = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";

    expect(graficos).toHaveLength(8);
    for (const aba of ["Painel", "Consolidado", "Faturamento", "Unidades", "Pedidos", "Por conta", "Glossário"]) {
      expect(workbook).toContain(`name="${aba}"`);
    }
    // O Painel é a primeira aba e é ela que tem o desenho.
    expect((await zip.file("xl/worksheets/sheet1.xml")?.async("string")) ?? "").toContain("<drawing r:id=");
    expect((await zip.file("xl/charts/chart1.xml")?.async("string")) ?? "").toContain("&apos;Painel&apos;!$");
  });

  it("recorte sem venda: o arquivo sai, sem gráfico que aponte para tabela vazia", async () => {
    const arquivo = await buildAbcWorkbook({
      curves: vazio,
      breakdowns: recortes,
      byAccount: [],
      accounts: [],
      organizationName: null,
      recorte: "vazio",
      dayCount: 30,
      generatedAt: new Date("2026-10-07T12:00:00Z"),
    });
    const zip = await JSZip.loadAsync(arquivo);

    // Só o de movimento (contagens, que existem mesmo zeradas).
    expect(Object.keys(zip.files).filter((f) => /^xl\/charts\/chart\d+\.xml$/.test(f))).toHaveLength(1);
  });
});
