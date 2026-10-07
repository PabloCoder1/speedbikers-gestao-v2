import ExcelJS from "exceljs";

import { formatDateTime } from "../../../lib/format";
import {
  consolidateCurves,
  summarizeCurve,
  type AbcCriterionKey,
  type AbcCurveRow,
  type SkuExtra,
} from "./rows";

/**
 * A planilha da Curva ABC: um Resumo, a aba Consolidada (uma linha por SKU com
 * as três curvas lado a lado) e uma aba por critério com a curva inteira.
 *
 * Mesma forma das outras exportações (`app/precos/export`, `app/compras/[id]/
 * export`): cabeçalho com o contexto, tabela com filtro automático e cabeçalho
 * congelado, rodapé com a hora. Número vai como NÚMERO (com formato), nunca
 * como texto, para a planilha somar; ausência vai como célula vazia, nunca zero.
 */

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
const CLASS_FILL: Readonly<Record<"A" | "B" | "C", ExcelJS.Fill>> = {
  A: { type: "pattern", pattern: "solid", fgColor: { argb: "FFD1FAE5" } },
  B: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } },
  C: { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } },
};

const CURRENCY = '"R$" #,##0.00';
const INTEGER = "#,##0";
const PERCENT = "0.00%";

const CRITERIOS: readonly { key: AbcCriterionKey; aba: string; rotulo: string; formato: string }[] = [
  { key: "faturamento", aba: "Faturamento", rotulo: "Faturamento (R$)", formato: CURRENCY },
  { key: "unidades", aba: "Unidades", rotulo: "Unidades vendidas", formato: INTEGER },
  { key: "pedidos", aba: "Pedidos", rotulo: "Pedidos", formato: INTEGER },
];

function cabecalho(sheet: ExcelJS.Worksheet, linha: number, titulos: readonly string[]): void {
  const row = sheet.getRow(linha);
  row.values = [...titulos];
  row.height = 30;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: "middle", wrapText: true };
  });
}

function topo(sheet: ExcelJS.Worksheet, colunas: number, titulo: string, input: { organizationName: string | null; recorte: string }): number {
  const ultima = sheet.getColumn(colunas).letter;

  sheet.mergeCells(`A1:${ultima}1`);
  sheet.getCell("A1").value = input.organizationName ?? "Speed Bikers";
  sheet.getCell("A1").font = { size: 16, bold: true };

  sheet.mergeCells(`A2:${ultima}2`);
  sheet.getCell("A2").value = titulo;
  sheet.getCell("A2").font = { size: 12, bold: true, color: { argb: "FF4B5563" } };

  sheet.mergeCells(`A3:${ultima}3`);
  sheet.getCell("A3").value = `Recorte: ${input.recorte}`;
  sheet.getCell("A3").font = { size: 10, color: { argb: "FF4B5563" } };

  return 5;
}

function pintarClasse(cell: ExcelJS.Cell, classe: "A" | "B" | "C" | null): void {
  if (classe === null) return;

  cell.fill = CLASS_FILL[classe];
  cell.font = { bold: true };
  cell.alignment = { horizontal: "center" };
}

function finalizarTabela(sheet: ExcelJS.Worksheet, linhaCabecalho: number, ultimaLinha: number, colunas: number): void {
  sheet.views = [{ state: "frozen", ySplit: linhaCabecalho, xSplit: 0 }];
  sheet.autoFilter = {
    from: { row: linhaCabecalho, column: 1 },
    to: { row: Math.max(linhaCabecalho, ultimaLinha), column: colunas },
  };
}

function rodape(sheet: ExcelJS.Worksheet, linha: number, colunas: number, geradoEm: Date): void {
  sheet.mergeCells(`A${String(linha)}:${sheet.getColumn(colunas).letter}${String(linha)}`);
  const cell = sheet.getCell(`A${String(linha)}`);
  cell.value = `Gerado por Speed Bikers Gestão em ${formatDateTime(geradoEm.toISOString())}.`;
  cell.font = { italic: true, size: 9, color: { argb: "FF6B7280" } };
}

// `writeBuffer()` devolve o tipo interno `ExcelJS.Buffer`, que o pacote não
// exporta -- mesma razão das outras exportações para não anotar o retorno.
export function buildAbcWorkbook(input: {
  curves: Readonly<Record<AbcCriterionKey, readonly AbcCurveRow[]>>;
  extras: ReadonlyMap<string, SkuExtra>;
  organizationName: string | null;
  recorte: string;
  generatedAt: Date;
}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Speed Bikers Gestão";
  workbook.created = input.generatedAt;

  const contexto = { organizationName: input.organizationName, recorte: input.recorte };

  // ---------------------------------------------------------------- Resumo
  const resumo = workbook.addWorksheet("Resumo");
  resumo.columns = [{ width: 22 }, { width: 10 }, { width: 14 }, { width: 22 }, { width: 14 }];
  let r = topo(resumo, 5, "Curva ABC — resumo das três curvas", contexto);

  const notas = [
    "Classe A: SKUs que somam até 80% do total do critério · B: de 80% a 95% · C: acima de 95%.",
    "Cada curva é recalculada dentro do recorte (conta e marca), não é a fatia do recorte na curva geral.",
    "O arquivo traz TODAS as classes; use o filtro da coluna Classe para recortar.",
    "Fonte: vendas diárias por SKU (pedidos pagos), as mesmas da tela /curva-abc.",
  ];

  for (const nota of notas) {
    resumo.mergeCells(`A${String(r)}:E${String(r)}`);
    resumo.getCell(`A${String(r)}`).value = nota;
    resumo.getCell(`A${String(r)}`).font = { size: 10, color: { argb: "FF374151" } };
    r += 1;
  }

  r += 1;
  cabecalho(resumo, r, ["Critério", "Classe", "SKUs", "Total da classe", "% do total"]);
  r += 1;

  for (const criterio of CRITERIOS) {
    const sumario = summarizeCurve(criterio.key, input.curves[criterio.key]);

    for (const classe of sumario.classes) {
      const row = resumo.getRow(r);
      row.values = [criterio.rotulo, classe.classe, classe.skus, classe.valor, classe.participacao];
      pintarClasse(row.getCell(2), classe.classe);
      row.getCell(3).numFmt = INTEGER;
      row.getCell(4).numFmt = criterio.formato;
      row.getCell(5).numFmt = PERCENT;
      r += 1;
    }

    const total = resumo.getRow(r);
    total.values = [
      `${criterio.rotulo} — total`,
      "",
      sumario.totalSkus,
      sumario.classes.reduce((soma, c) => soma + c.valor, 0),
      sumario.classes.length === 0 ? null : 1,
    ];
    total.font = { bold: true };
    total.getCell(3).numFmt = INTEGER;
    total.getCell(4).numFmt = criterio.formato;
    total.getCell(5).numFmt = PERCENT;
    total.border = { top: { style: "thin", color: { argb: "FF9CA3AF" } } };
    r += 2;
  }

  const semFull = summarizeCurve("faturamento", input.curves.faturamento).withoutFull;
  resumo.getCell(`A${String(r)}`).value = "SKUs sem estoque no Full";
  resumo.getCell(`A${String(r)}`).font = { bold: true };
  resumo.getCell(`C${String(r)}`).value = semFull;
  resumo.getCell(`C${String(r)}`).numFmt = INTEGER;
  r += 2;
  rodape(resumo, r, 5, input.generatedAt);

  // ----------------------------------------------------------- Consolidado
  const consolidado = workbook.addWorksheet("Consolidado");
  const colunasConsolidado = [
    ["Posição", 8],
    ["SKU", 18],
    ["Produto", 46],
    ["Marca", 18],
    ["Classe faturamento", 11],
    ["Classe unidades", 11],
    ["Classe pedidos", 11],
    ["Classes (F/U/P)", 10],
    ["Faturamento (R$)", 16],
    ["% do faturamento", 12],
    ["% acumulado", 12],
    ["Unidades", 11],
    ["Pedidos", 11],
    ["Ticket médio (R$)", 14],
    ["Preço médio por unidade (R$)", 15],
    ["Custo unitário (R$)", 14],
    ["Estoque local", 11],
    ["Estoque Full", 11],
    ["Sem Full", 9],
  ] as const;
  consolidado.columns = colunasConsolidado.map(([, width]) => ({ width }));
  let c = topo(consolidado, colunasConsolidado.length, "Curva ABC — consolidado por SKU", contexto);
  const cabecalhoConsolidado = c;
  cabecalho(consolidado, c, colunasConsolidado.map(([titulo]) => titulo));
  c += 1;

  const linhas = consolidateCurves(input.curves, input.extras);

  linhas.forEach((linha, indice) => {
    const row = consolidado.getRow(c);
    row.values = [
      indice + 1,
      linha.sku,
      linha.title,
      linha.brand,
      linha.classRevenue,
      linha.classUnits,
      linha.classOrders,
      linha.combinedClass,
      linha.revenue,
      linha.revenueShare,
      linha.revenueCumulative,
      linha.units,
      linha.orders,
      linha.averageTicket,
      linha.averageUnitPrice,
      linha.purchaseCost,
      linha.localStock,
      linha.fullStock,
      linha.fullStock === 0 ? "Sim" : "Não",
    ];
    pintarClasse(row.getCell(5), linha.classRevenue);
    pintarClasse(row.getCell(6), linha.classUnits);
    pintarClasse(row.getCell(7), linha.classOrders);
    row.getCell(8).alignment = { horizontal: "center" };
    row.getCell(9).numFmt = CURRENCY;
    row.getCell(10).numFmt = PERCENT;
    row.getCell(11).numFmt = PERCENT;
    row.getCell(12).numFmt = INTEGER;
    row.getCell(13).numFmt = INTEGER;
    row.getCell(14).numFmt = CURRENCY;
    row.getCell(15).numFmt = CURRENCY;
    row.getCell(16).numFmt = CURRENCY;
    row.getCell(17).numFmt = INTEGER;
    row.getCell(18).numFmt = INTEGER;
    c += 1;
  });

  finalizarTabela(consolidado, cabecalhoConsolidado, c - 1, colunasConsolidado.length);
  rodape(consolidado, c + 1, colunasConsolidado.length, input.generatedAt);

  // ------------------------------------------------------- Uma por critério
  for (const criterio of CRITERIOS) {
    const sheet = workbook.addWorksheet(criterio.aba);
    const colunas = [
      ["Posição", 8],
      ["Classe", 8],
      ["SKU", 18],
      ["Produto", 46],
      ["Marca", 18],
      [criterio.rotulo, 16],
      ["% do total", 11],
      ["% acumulado", 12],
      ["Estoque Full", 11],
    ] as const;
    sheet.columns = colunas.map(([, width]) => ({ width }));
    let l = topo(sheet, colunas.length, `Curva ABC por ${criterio.rotulo.toLowerCase()}`, contexto);
    const linhaCabecalho = l;
    cabecalho(sheet, l, colunas.map(([titulo]) => titulo));
    l += 1;

    input.curves[criterio.key].forEach((linha, indice) => {
      const row = sheet.getRow(l);
      row.values = [
        indice + 1,
        linha.abc_class,
        linha.sku,
        linha.title ?? "Produto sem título",
        input.extras.get(linha.sku_id)?.supplierBrand ?? null,
        linha.metric_value,
        linha.metric_share / 100,
        linha.cumulative_share / 100,
        linha.full_quantity,
      ];
      pintarClasse(row.getCell(2), linha.abc_class);
      row.getCell(6).numFmt = criterio.formato;
      row.getCell(7).numFmt = PERCENT;
      row.getCell(8).numFmt = PERCENT;
      row.getCell(9).numFmt = INTEGER;
      l += 1;
    });

    finalizarTabela(sheet, linhaCabecalho, l - 1, colunas.length);
    rodape(sheet, l + 1, colunas.length, input.generatedAt);
  }

  return workbook.xlsx.writeBuffer();
}
