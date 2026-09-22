import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

import { formatBusinessDate, formatCurrency, formatDateTime } from "../../../../lib/format";
import { purchaseOrderStatusLabel } from "../../../../lib/labels";
import type { PurchaseOrderExportData } from "./load";
import { includesPurchaseOrderValues, type PurchaseOrderExportMode } from "./mode";
import { buildExportRows, computeExportTotal } from "./rows";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const ROW_HEIGHT = 20;

const DARK = rgb(0.12, 0.16, 0.22);
const GRAY = rgb(0.42, 0.45, 0.5);
const WHITE = rgb(1, 1, 1);
const BORDER = rgb(0.85, 0.86, 0.88);

// [SKU, Descrição, Origem, Quantidade, Custo unitário, Subtotal]
const COLUMNS_WITH_VALUES = [90, 155, 55, 40, 85, 90] as const;
const COLUMNS_WITHOUT_VALUES = [115, 285, 80, 60] as const;

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

/**
 * Layout PRÓPRIO, desenhado célula a célula — `pdf-lib` não tem tabela
 * pronta. Escopo deliberadamente simples (uma página de itens, quebra só se
 * a lista for maior que isso — o único pedido real conhecido tinha 5 itens,
 * D-040): mesmo raciocínio de "modelo provisório" do `workbook.ts`.
 */
export async function buildPurchaseOrderPdf(data: PurchaseOrderExportData, mode: PurchaseOrderExportMode): Promise<Uint8Array> {
  const includeValues = includesPurchaseOrderValues(mode);
  const columnWidths = includeValues ? COLUMNS_WITH_VALUES : COLUMNS_WITHOUT_VALUES;
  const doc = await PDFDocument.create();
  doc.setTitle(`Pedido de compra #${String(data.orderNumber)}`);
  doc.setProducer("Speed Bikers Gestão");

  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  function ensureSpace(needed: number): boolean {
    if (y - needed < MARGIN) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;

      return true;
    }

    return false;
  }

  function text(value: string, x: number, size: number, bold = false, color = DARK): void {
    page.drawText(value, { x, y, size, font: bold ? fonts.bold : fonts.regular, color });
  }

  text(data.organizationName ?? "Speed Bikers", MARGIN, 18, true);
  y -= 22;
  text(`Pedido de compra #${String(data.orderNumber)} — ${purchaseOrderStatusLabel(data.status)}`, MARGIN, 12, true, GRAY);
  y -= 26;

  const infoLines: [string, string][] = [
    ["Fornecedor", data.supplierName ?? "—"],
    ["CNPJ/documento do fornecedor", data.supplierDocument ?? "—"],
    ["CNPJ da organização", data.organizationCnpj ?? "—"],
    ["Destino", data.destinationWarehouseName ?? "—"],
    ...(includeValues ? [["Moeda", data.currency] as [string, string]] : []),
    ["Criado em", formatDateTime(data.createdAt)],
    ["Previsão de entrega", data.expectedAt === null ? "—" : formatBusinessDate(data.expectedAt.slice(0, 10))],
  ];

  for (const [label, value] of infoLines) {
    ensureSpace(16);
    text(`${label}:`, MARGIN, 10, true);
    text(value, MARGIN + 170, 10);
    y -= 15;
  }

  if (data.notes !== null && data.notes.trim() !== "") {
    ensureSpace(16);
    text("Observações:", MARGIN, 10, true);
    text(data.notes, MARGIN + 170, 10);
    y -= 15;
  }

  y -= 10;

  const headers = ["SKU", "Descrição", "Origem", "Qtd.", "Custo unit.", "Subtotal"];
  const visibleHeaders = includeValues ? headers : headers.slice(0, 4);
  drawTableHeader(page, fonts, MARGIN, y, visibleHeaders, columnWidths);
  y -= ROW_HEIGHT;

  const itemRows = buildExportRows(data.items);

  for (const item of itemRows) {
    const brokePage = ensureSpace(ROW_HEIGHT + 40);

    if (brokePage) {
      // Página nova começou no meio da tabela: repete o cabeçalho.
      drawTableHeader(page, fonts, MARGIN, y, visibleHeaders, columnWidths);
      y -= ROW_HEIGHT;
    }

    drawTableRow(page, fonts, MARGIN, y, [
      item.sku,
      item.title,
      item.origin,
      String(item.quantity),
      item.unitCost === null ? "—" : formatCurrency(item.unitCost),
      item.subtotal === null ? "—" : formatCurrency(item.subtotal),
    ], columnWidths);
    y -= ROW_HEIGHT;
  }

  if (includeValues) {
    ensureSpace(30);
    y -= 10;
    const totalX = MARGIN + columnWidths.slice(0, 4).reduce((sum, width) => sum + width, 0);
    text("Total", totalX, 11, true);
    text(formatCurrency(computeExportTotal(itemRows)), totalX + (columnWidths[4] ?? 0), 11, true);
  }

  ensureSpace(40);
  y -= 30;
  text(
    `Gerado por Speed Bikers Gestão em ${formatDateTime(new Date().toISOString())} — layout provisório, sujeito a ajuste.`,
    MARGIN,
    8,
    false,
    GRAY,
  );

  return doc.save();
}

function drawTableHeader(page: PDFPage, fonts: Fonts, x0: number, y: number, headers: string[], columnWidths: readonly number[]): void {
  let x = x0;
  const totalWidth = columnWidths.reduce((sum, width) => sum + width, 0);

  page.drawRectangle({ x: x0, y: y - ROW_HEIGHT + 5, width: totalWidth, height: ROW_HEIGHT, color: DARK });

  headers.forEach((label, index) => {
    page.drawText(label, { x: x + 4, y: y - 10, size: 9, font: fonts.bold, color: WHITE });
    x += columnWidths[index] ?? 0;
  });
}

function drawTableRow(page: PDFPage, fonts: Fonts, x0: number, y: number, values: string[], columnWidths: readonly number[]): void {
  let x = x0;
  const totalWidth = columnWidths.reduce((sum, width) => sum + width, 0);

  page.drawLine({
    start: { x: x0, y: y - ROW_HEIGHT + 5 },
    end: { x: x0 + totalWidth, y: y - ROW_HEIGHT + 5 },
    thickness: 0.5,
    color: BORDER,
  });

  values.slice(0, columnWidths.length).forEach((value, index) => {
    const width = columnWidths[index] ?? 0;
    const truncated = truncateToWidth(value, width, fonts.regular, 8);
    page.drawText(truncated, { x: x + 4, y: y - 10, size: 8, font: fonts.regular, color: DARK });
    x += width;
  });
}

function truncateToWidth(value: string, width: number, font: PDFFont, size: number): string {
  if (font.widthOfTextAtSize(value, size) <= width - 6) return value;

  let truncated = value;

  while (truncated.length > 1 && font.widthOfTextAtSize(`${truncated}…`, size) > width - 6) {
    truncated = truncated.slice(0, -1);
  }

  return `${truncated}…`;
}
