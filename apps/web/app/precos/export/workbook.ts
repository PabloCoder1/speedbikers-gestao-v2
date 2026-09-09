import ExcelJS from "exceljs";

import { formatBusinessDate, formatCount, formatDateTime } from "../../../lib/format";
import { listingStatusLabel } from "../../../lib/labels";
import { priceDirectionLabel } from "../../../lib/price-filters";
import type { PriceExportData } from "./load";
import { buildPriceExportRows, describePriceExportFilters, toSpreadsheetInstant } from "./rows";

/**
 * A planilha do Histórico de Preços (D-292).
 *
 * Mesma forma da exportação de pedido de compra (`app/compras/[id]/export`):
 * cabeçalho com o contexto, tabela, rodapé com a hora da geração. O que muda é
 * o que o cabeçalho PRECISA carregar aqui — lá o documento se identifica pelo
 * número do pedido; aqui o arquivo é um RECORTE, e recorte sem descrição é uma
 * lista de números sem dono.
 *
 * **Só XLSX, sem PDF.** O par PDF existe em pedido de compra porque aquilo é
 * documento que se manda ao fornecedor. Isto é dado para cruzar em planilha —
 * um PDF de 244 linhas seria a versão que ninguém consegue usar.
 */

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F2937" },
};

const AVISO_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFDE68A" },
};

const CURRENCY_FORMAT = '"R$" #,##0.00';
const PERCENT_FORMAT = "+0.00%;-0.00%";
const DATETIME_FORMAT = "dd/mm/yyyy hh:mm";

// `writeBuffer()` devolve o tipo interno `ExcelJS.Buffer`, que o pacote não
// exporta — mesma razão de `compras/[id]/export/workbook.ts` para não anotar.
export function buildPriceChangesWorkbook(input: {
  data: PriceExportData;
  organizationName: string | null;
  accountLabel: string | null;
  direction: string | null;
  search: string | null;
  generatedAt: Date;
}) {
  const { data } = input;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Speed Bikers Gestão";
  workbook.created = input.generatedAt;

  const sheet = workbook.addWorksheet("Histórico de preços", {
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true },
    views: [{ state: "frozen", ySplit: 0 }],
  });

  sheet.columns = [
    { width: 18 },
    { width: 40 },
    { width: 18 },
    { width: 16 },
    { width: 14 },
    { width: 18 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 12 },
    { width: 12 },
  ];

  sheet.mergeCells("A1:K1");
  const titulo = sheet.getCell("A1");
  titulo.value = input.organizationName ?? "Speed Bikers";
  titulo.font = { size: 16, bold: true };

  sheet.mergeCells("A2:K2");
  const subtitulo = sheet.getCell("A2");
  subtitulo.value = "Histórico de preços — alterações observadas";
  subtitulo.font = { size: 12, bold: true, color: { argb: "FF4B5563" } };

  let row = 4;

  function infoLine(label: string, value: string): void {
    sheet.getCell(`A${String(row)}`).value = label;
    sheet.getCell(`A${String(row)}`).font = { bold: true };
    sheet.mergeCells(`B${String(row)}:K${String(row)}`);
    sheet.getCell(`B${String(row)}`).value = value;
    row += 1;
  }

  infoLine(
    "Recorte",
    describePriceExportFilters({
      dayFrom: data.dayFrom,
      dayTo: data.dayTo,
      accountLabel: input.accountLabel,
      direction: input.direction,
      search: input.search,
      formatDay: formatBusinessDate,
      directionLabel: priceDirectionLabel,
    }),
  );

  /*
    A MESMA ressalva que a tela imprime: a série começa quando a sincronização
    da organização começou, e antes disso não há ausência de mudança — há
    ausência de observação. Fora da tela isso importa mais, não menos: a
    planilha viaja.
  */
  infoLine(
    "Alcance do registro",
    data.seriesStart === null
      ? "Nenhuma alteração registrada para esta organização."
      : `O registro de preços começa em ${formatBusinessDate(data.seriesStart)} — antes disso não há observação, e ausência de linha não é ausência de mudança.`,
  );

  infoLine(
    "Linhas",
    data.truncated
      ? `${formatCount(data.rows.length)} de ${formatCount(data.totalCount)} — TETO DE EXPORTAÇÃO ATINGIDO`
      : `${formatCount(data.rows.length)} de ${formatCount(data.totalCount)}`,
  );

  /*
    O TETO NÃO PODE SER UMA NOTA DE RODAPÉ. Um arquivo cortado que parece
    inteiro é a classe de defeito de D-131/D-138 — a diferença é que aqui o
    número já saiu do sistema e vai ser somado por alguém.
  */
  if (data.truncated) {
    sheet.mergeCells(`A${String(row)}:K${String(row)}`);
    const aviso = sheet.getCell(`A${String(row)}`);
    aviso.value = `ATENÇÃO: este arquivo tem ${formatCount(data.rows.length)} das ${formatCount(data.totalCount)} alterações do recorte. Estreite o período, a conta ou a direção e exporte de novo — as linhas que faltam são as mais antigas.`;
    aviso.font = { bold: true, color: { argb: "FF7C2D12" } };
    aviso.fill = AVISO_FILL;
    row += 1;
  }

  row += 1;

  const cabecalho = sheet.getRow(row);
  cabecalho.values = [
    // O fuso vai NO TÍTULO: o XLSX guarda relógio de parede, sem fuso, e
    // quem abrir o arquivo precisa saber de qual relógio ele fala.
    "Data / Hora (São Paulo)",
    "Anúncio",
    "SKU",
    "MLB",
    "Situação",
    "Conta",
    "Preço anterior",
    "Preço atual",
    "Variação R$",
    "Variação %",
    "Direção",
  ];
  cabecalho.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: "middle" };
  });
  row += 1;

  const linhas = buildPriceExportRows(data.rows, listingStatusLabel);

  for (const linha of linhas) {
    const r = sheet.getRow(row);

    r.values = [
      toSpreadsheetInstant(linha.occurredAt),
      linha.title,
      linha.sku,
      linha.itemId,
      linha.status,
      linha.account,
      linha.priceBefore,
      linha.priceAfter,
      linha.delta,
      // `null` vira célula VAZIA, nunca zero: preço anterior zero não tem
      // variação percentual definida, e 0% seria resposta errada (D-067).
      linha.deltaRatio,
      linha.direction,
    ];

    r.getCell(1).numFmt = DATETIME_FORMAT;
    r.getCell(7).numFmt = CURRENCY_FORMAT;
    r.getCell(8).numFmt = CURRENCY_FORMAT;
    r.getCell(9).numFmt = CURRENCY_FORMAT;
    r.getCell(10).numFmt = PERCENT_FORMAT;

    row += 1;
  }

  // A faixa congelada só faz sentido depois de saber onde o cabeçalho ficou.
  const linhaCabecalho = row - linhas.length - 1;
  sheet.views = [{ state: "frozen", ySplit: linhaCabecalho }];
  sheet.autoFilter = {
    from: { row: linhaCabecalho, column: 1 },
    to: { row: Math.max(linhaCabecalho, row - 1), column: 11 },
  };

  row += 1;

  sheet.mergeCells(`A${String(row)}:K${String(row)}`);
  const rodape = sheet.getCell(`A${String(row)}`);
  rodape.value = `Gerado por Speed Bikers Gestão em ${formatDateTime(input.generatedAt.toISOString())}.`;
  rodape.font = { italic: true, size: 9, color: { argb: "FF6B7280" } };

  return workbook.xlsx.writeBuffer();
}
