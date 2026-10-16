import { describe, expect, it } from "vitest";

import { buildExportRows, computeExportTotal } from "./rows";

describe("linhas de exportação do pedido de compra", () => {
  it("importado/nacional/sem SKU vinculado viram os três rótulos certos", () => {
    const rows = buildExportRows([
      { skuSnapshot: "A", titleSnapshot: null, isImported: true, quantityOrdered: 1, unitCost: 10 },
      { skuSnapshot: "B", titleSnapshot: null, isImported: false, quantityOrdered: 1, unitCost: 10 },
      { skuSnapshot: "C", titleSnapshot: null, isImported: null, quantityOrdered: 1, unitCost: 10 },
    ]);

    expect(rows.map((r) => r.origin)).toEqual(["Importado", "Nacional", "—"]);
  });

  it("título nulo vira string vazia, nunca 'null' literal", () => {
    const [row] = buildExportRows([
      { skuSnapshot: "A", titleSnapshot: null, isImported: null, quantityOrdered: 1, unitCost: 1 },
    ]);

    expect(row?.title).toBe("");
  });

  it("custo unitário nulo produz subtotal nulo, não zero — custo desconhecido não é custo zero", () => {
    const [row] = buildExportRows([
      { skuSnapshot: "A", titleSnapshot: null, isImported: null, quantityOrdered: 5, unitCost: null },
    ]);

    expect(row?.subtotal).toBeNull();
  });

  it("subtotal é quantidade vezes custo unitário", () => {
    const [row] = buildExportRows([
      { skuSnapshot: "A", titleSnapshot: null, isImported: null, quantityOrdered: 3, unitCost: 2.5 },
    ]);

    expect(row?.subtotal).toBe(7.5);
  });

  it("total soma só os subtotais conhecidos, ignora item com custo nulo", () => {
    const rows = buildExportRows([
      { skuSnapshot: "A", titleSnapshot: null, isImported: null, quantityOrdered: 2, unitCost: 10 },
      { skuSnapshot: "B", titleSnapshot: null, isImported: null, quantityOrdered: 1, unitCost: null },
      { skuSnapshot: "C", titleSnapshot: null, isImported: null, quantityOrdered: 4, unitCost: 5 },
    ]);

    expect(computeExportTotal(rows)).toBe(40);
  });

  it("lista vazia produz total zero", () => {
    expect(computeExportTotal([])).toBe(0);
  });
});
