/**
 * Layout PRÓPRIO, não o modelo oficial do usuário — D-034 seguia bloqueado
 * por falta dos modelos de referência; o usuário liberou implementar com um
 * layout profissional à minha escolha, a ser ajustado quando o modelo
 * oficial chegar (2026-08-23). Mantido pequeno de propósito: uma função pura
 * (testável sem `exceljs`/`pdf-lib`) que decide o que aparece em cada linha,
 * consumida pelos dois formatos (`workbook.ts`/`pdf.ts`).
 */

export interface PurchaseOrderExportItem {
  skuSnapshot: string;
  titleSnapshot: string | null;
  isImported: boolean | null;
  quantityOrdered: number;
  unitCost: number | null;
}

export interface ExportRow {
  sku: string;
  title: string;
  origin: string;
  quantity: number;
  unitCost: number | null;
  subtotal: number | null;
}

export function buildExportRows(items: PurchaseOrderExportItem[]): ExportRow[] {
  return items.map((item) => ({
    sku: item.skuSnapshot,
    title: item.titleSnapshot ?? "",
    origin: item.isImported === true ? "Importado" : item.isImported === false ? "Nacional" : "—",
    quantity: item.quantityOrdered,
    unitCost: item.unitCost,
    subtotal: item.unitCost === null ? null : item.quantityOrdered * item.unitCost,
  }));
}

export function computeExportTotal(rows: ExportRow[]): number {
  return rows.reduce((sum, row) => sum + (row.subtotal ?? 0), 0);
}
