import ExcelJS from "exceljs";

import { formatDateTime } from "../../../../lib/format";
import { purchaseOrderStatusLabel } from "../../../../lib/labels";
import type { PurchaseOrderExportData } from "./load";
import { buildExportRows, computeExportTotal } from "./rows";

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F2937" },
};

const CURRENCY_FORMAT = '"R$" #,##0.00';

// `writeBuffer()` devolve o tipo interno `ExcelJS.Buffer` (compatível com
// ArrayBuffer, não o `Buffer` global do Node, e não exportado pelo pacote) —
// deixar o retorno sem anotação evita nomear um tipo inacessível fora daqui.
export async function buildPurchaseOrderWorkbook(data: PurchaseOrderExportData) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Speed Bikers Gestão";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Pedido de compra", {
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true },
  });

  sheet.columns = [
    { width: 20 },
    { width: 34 },
    { width: 12 },
    { width: 12 },
    { width: 16 },
    { width: 16 },
  ];

  sheet.mergeCells("A1:F1");
  const title = sheet.getCell("A1");
  title.value = data.organizationName ?? "Speed Bikers";
  title.font = { size: 16, bold: true };

  sheet.mergeCells("A2:F2");
  const subtitle = sheet.getCell("A2");
  subtitle.value = `Pedido de compra #${String(data.orderNumber)} — ${purchaseOrderStatusLabel(data.status)}`;
  subtitle.font = { size: 12, bold: true, color: { argb: "FF4B5563" } };

  let row = 4;

  function infoLine(label: string, value: string): void {
    sheet.getCell(`A${String(row)}`).value = label;
    sheet.getCell(`A${String(row)}`).font = { bold: true };
    sheet.mergeCells(`B${String(row)}:F${String(row)}`);
    sheet.getCell(`B${String(row)}`).value = value;
    row += 1;
  }

  infoLine("Fornecedor", data.supplierName ?? "—");
  infoLine("CNPJ/documento do fornecedor", data.supplierDocument ?? "—");
  infoLine("CNPJ da organização", data.organizationCnpj ?? "—");
  infoLine("Destino", data.destinationWarehouseName ?? "—");
  infoLine("Moeda", data.currency);
  infoLine("Criado em", formatDateTime(data.createdAt));
  infoLine("Previsão de entrega", data.expectedAt === null ? "—" : formatDateTime(data.expectedAt));

  if (data.notes !== null && data.notes.trim() !== "") {
    infoLine("Observações", data.notes);
  }

  row += 1;

  const headerRow = sheet.getRow(row);
  headerRow.values = ["SKU", "Descrição", "Origem", "Quantidade", "Custo unitário", "Subtotal"];
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: "middle" };
  });
  row += 1;

  const itemRows = buildExportRows(data.items);

  for (const item of itemRows) {
    const r = sheet.getRow(row);
    r.values = [item.sku, item.title, item.origin, item.quantity, item.unitCost, item.subtotal];
    r.getCell(5).numFmt = CURRENCY_FORMAT;
    r.getCell(6).numFmt = CURRENCY_FORMAT;
    row += 1;
  }

  const totalRow = sheet.getRow(row);
  totalRow.getCell(5).value = "Total";
  totalRow.getCell(5).font = { bold: true };
  totalRow.getCell(6).value = computeExportTotal(itemRows);
  totalRow.getCell(6).numFmt = CURRENCY_FORMAT;
  totalRow.getCell(6).font = { bold: true };
  row += 2;

  sheet.mergeCells(`A${String(row)}:F${String(row)}`);
  const footer = sheet.getCell(`A${String(row)}`);
  footer.value = `Gerado por Speed Bikers Gestão em ${formatDateTime(new Date().toISOString())} — layout provisório, sujeito a ajuste.`;
  footer.font = { italic: true, size: 9, color: { argb: "FF6B7280" } };

  return workbook.xlsx.writeBuffer();
}
