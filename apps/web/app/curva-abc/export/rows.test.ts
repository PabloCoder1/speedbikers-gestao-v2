import { describe, expect, it } from "vitest";

import { consolidateCurves, describeAbcExport, summarizeCurve, type AbcCurveRow } from "./rows";

function linha(sku: string, metric: number, classe: "A" | "B" | "C", extra: Partial<AbcCurveRow> = {}): AbcCurveRow {
  return {
    sku_id: `id-${sku}`,
    sku,
    title: `Produto ${sku}`,
    metric_value: metric,
    metric_share: 50,
    cumulative_share: 50,
    abc_class: classe,
    full_quantity: 3,
    total_count: 2,
    class_a_count: 1,
    class_b_count: 1,
    class_c_count: 0,
    class_a_value: 800,
    class_b_value: 200,
    class_c_value: 0,
    without_full_count: 1,
    ...extra,
  };
}

describe("consolidateCurves", () => {
  it("junta as três curvas por SKU, na ordem do faturamento, e os de fora no fim", () => {
    const linhas = consolidateCurves(
      {
        faturamento: [linha("X", 800, "A"), linha("Y", 200, "B")],
        unidades: [linha("Y", 30, "A"), linha("X", 10, "B"), linha("Z", 5, "C")],
        pedidos: [linha("X", 8, "A"), linha("Y", 4, "B")],
      },
      new Map([["id-X", { supplierBrand: "Pro Tork", purchaseCost: 40, localStock: 12 }]]),
    );

    expect(linhas.map((l) => l.sku)).toEqual(["X", "Y", "Z"]);
    expect(linhas[0]).toMatchObject({
      brand: "Pro Tork",
      purchaseCost: 40,
      localStock: 12,
      revenue: 800,
      units: 10,
      orders: 8,
      combinedClass: "ABA",
      averageTicket: 100,
      averageUnitPrice: 80,
      revenueShare: 0.5,
    });
  });

  it("SKU que só entra numa curva: as outras ficam vazias, nunca zero, e sem razão dividida por nada", () => {
    const [z] = consolidateCurves({ faturamento: [], unidades: [linha("Z", 5, "C")], pedidos: [] }, new Map());

    expect(z).toMatchObject({
      revenue: null,
      orders: null,
      units: 5,
      classRevenue: null,
      combinedClass: "-C-",
      averageTicket: null,
      averageUnitPrice: null,
      brand: null,
      localStock: null,
    });
  });

  it("pedido zero não vira ticket infinito", () => {
    const [x] = consolidateCurves(
      { faturamento: [linha("X", 100, "A")], unidades: [linha("X", 0, "C")], pedidos: [linha("X", 0, "C")] },
      new Map(),
    );

    expect(x?.averageTicket).toBeNull();
    expect(x?.averageUnitPrice).toBeNull();
  });
});

describe("summarizeCurve", () => {
  it("classes com valor, SKUs e participação sobre A+B+C", () => {
    const s = summarizeCurve("faturamento", [linha("X", 800, "A")]);

    expect(s).toMatchObject({ totalSkus: 2, withoutFull: 1 });
    expect(s.classes.map((c) => [c.classe, c.skus, c.valor, c.participacao])).toEqual([
      ["A", 1, 800, 0.8],
      ["B", 1, 200, 0.2],
      ["C", 0, 0, 0],
    ]);
  });

  it("curva vazia não inventa classes", () => {
    expect(summarizeCurve("pedidos", [])).toEqual({ criterion: "pedidos", totalSkus: 0, withoutFull: 0, classes: [] });
  });

  it("total zero: participação vazia, nunca 0%", () => {
    const s = summarizeCurve("unidades", [linha("X", 0, "A", { class_a_value: 0, class_b_value: 0, class_c_value: 0 })]);

    expect(s.classes.every((c) => c.participacao === null)).toBe(true);
  });
});

describe("describeAbcExport", () => {
  it("diz o recorte inteiro", () => {
    expect(
      describeAbcExport({
        days: 90,
        dateFrom: "2026-07-09",
        dateTo: "2026-10-06",
        accountLabel: "Speedbikers (loja 1)",
        brand: "Pro Tork",
        onlyWithoutFull: true,
        formatDay: (d) => d.split("-").reverse().join("/"),
      }),
    ).toBe(
      "últimos 90 dias (09/07/2026 a 06/10/2026) · conta Speedbikers (loja 1) · marca Pro Tork · somente SKUs sem estoque no Full",
    );
  });
});
