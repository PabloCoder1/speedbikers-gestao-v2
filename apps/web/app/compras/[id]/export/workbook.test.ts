import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import type { PurchaseOrderExportData } from "./load";
import { buildPurchaseOrderWorkbook } from "./workbook";

const data: PurchaseOrderExportData = {
  orderNumber: 42,
  status: "DRAFT",
  organizationName: "Speed Bikers",
  organizationCnpj: null,
  supplierName: "Fornecedor",
  supplierDocument: null,
  destinationWarehouseName: null,
  currency: "BRL",
  notes: null,
  expectedAt: null,
  approvedAt: null,
  orderedAt: null,
  receivedAt: null,
  createdAt: "2026-09-22T12:00:00.000Z",
  items: [{ skuSnapshot: "SKU-1", titleSnapshot: "Produto", isImported: false, quantityOrdered: 2, unitCost: 50 }],
};

async function headers(mode: "WITH_VALUES" | "WITHOUT_VALUES"): Promise<unknown[]> {
  const result = await buildPurchaseOrderWorkbook(data, mode);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(result);
  const sheet = workbook.getWorksheet("Pedido de compra");
  if (sheet === undefined) return [];

  const row = (sheet.getRows(1, sheet.rowCount) ?? []).find((candidate) => candidate.getCell(1).value === "SKU");
  if (row === undefined) return [];

  return Array.from({ length: row.cellCount }, (_, index) => {
    const value = row.getCell(index + 1).value;
    return typeof value === "string" ? value : "";
  });
}

describe("Excel do pedido de compra", () => {
  it("omite custos e total na copia para fornecedor", async () => {
    const result = await headers("WITHOUT_VALUES");
    expect(result).toEqual(["SKU", "Descri\u00e7\u00e3o", "Origem", "Quantidade"]);
  });

  it("mantem valores somente na copia interna", async () => {
    const result = await headers("WITH_VALUES");
    expect(result).toEqual(["SKU", "Descri\u00e7\u00e3o", "Origem", "Quantidade", "Custo unit\u00e1rio", "Subtotal"]);
  });
});
