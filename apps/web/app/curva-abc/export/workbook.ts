import ExcelJS from "exceljs";

import { formatDateTime } from "../../../lib/format";
import { addChartsToXlsx, rangeRef, type ChartSpec } from "../../../lib/xlsx-charts";
import {
  consolidateCurves,
  migrationMatrix,
  monthLabel,
  movementLabel,
  pivotByAccount,
  razao,
  summarizeCurve,
  variacao,
  type AbcAnalysisRow,
  type AbcBreakdownRow,
  type AbcClassLetter,
  type AbcCriterionKey,
  type AbcDimension,
  type AccountColumn,
  type SkuAccountSales,
} from "./rows";

/**
 * A planilha da Curva ABC (D-422, D-424).
 *
 * - **Painel**: indicadores do recorte contra o período anterior, oito
 *   gráficos nativos (Pareto, classes, contas, meses, top SKUs, marcas,
 *   categorias, movimento de classe) e, abaixo deles, as tabelas que os
 *   alimentam -- o gráfico aponta para essas células.
 * - **Consolidado**: uma linha por SKU com as três curvas, o período anterior,
 *   estoque, valor do estoque e cobertura; barras de dados e escala de cor.
 * - **Faturamento / Unidades / Pedidos**: a curva de cada critério.
 * - **Por conta**: o mesmo SKU em cada conta, lado a lado.
 * - **Glossário**: o que cada coluna quer dizer.
 *
 * Número vai como NÚMERO (com formato), nunca como texto, para a planilha
 * somar; ausência vai como célula vazia, nunca zero (D-067).
 */

const COR = {
  navy: "0E1259",
  a: "0E1259",
  b: "F2A93B",
  c: "8FA3BF",
  linha: "E4572E",
  verde: "2E9E6B",
  cinza: "6B7280",
} as const;

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
const SECTION_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF0FA" } };
const CLASS_FILL: Readonly<Record<AbcClassLetter, ExcelJS.Fill>> = {
  A: { type: "pattern", pattern: "solid", fgColor: { argb: "FFD1FAE5" } },
  B: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } },
  C: { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } },
};

const CURRENCY = '"R$" #,##0.00';
const CURRENCY_AXIS = '"R$" #,##0';
const INTEGER = "#,##0";
const DECIMAL = "#,##0.0";
const PERCENT = "0.00%";
const PERCENT_SIGNED = '+0.0%;-0.0%;0.0%';

const CRITERIOS: readonly { key: AbcCriterionKey; aba: string; rotulo: string; formato: string }[] = [
  { key: "faturamento", aba: "Faturamento", rotulo: "Faturamento (R$)", formato: CURRENCY },
  { key: "unidades", aba: "Unidades", rotulo: "Unidades vendidas", formato: INTEGER },
  { key: "pedidos", aba: "Pedidos", rotulo: "Pedidos", formato: INTEGER },
];

interface Contexto {
  organizationName: string | null;
  recorte: string;
}

function cabecalho(sheet: ExcelJS.Worksheet, linha: number, titulos: readonly string[], primeiraColuna = 1): void {
  titulos.forEach((titulo, i) => {
    const cell = sheet.getCell(linha, primeiraColuna + i);
    cell.value = titulo;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  sheet.getRow(linha).height = 30;
}

function topo(sheet: ExcelJS.Worksheet, colunas: number, titulo: string, contexto: Contexto): number {
  const ultima = sheet.getColumn(colunas).letter;

  sheet.mergeCells(`A1:${ultima}1`);
  sheet.getCell("A1").value = contexto.organizationName ?? "Speed Bikers";
  sheet.getCell("A1").font = { size: 16, bold: true, color: { argb: `FF${COR.navy}` } };

  sheet.mergeCells(`A2:${ultima}2`);
  sheet.getCell("A2").value = titulo;
  sheet.getCell("A2").font = { size: 12, bold: true, color: { argb: "FF4B5563" } };

  sheet.mergeCells(`A3:${ultima}3`);
  sheet.getCell("A3").value = `Recorte: ${contexto.recorte}`;
  sheet.getCell("A3").font = { size: 10, color: { argb: "FF4B5563" } };
  sheet.getCell("A3").alignment = { wrapText: true, vertical: "top" };
  sheet.getRow(3).height = 28;

  return 5;
}

function pintarClasse(cell: ExcelJS.Cell, classe: string | null): void {
  if (classe !== "A" && classe !== "B" && classe !== "C") return;

  cell.fill = CLASS_FILL[classe];
  cell.font = { bold: true };
  cell.alignment = { horizontal: "center" };
}

function finalizarTabela(sheet: ExcelJS.Worksheet, linhaCabecalho: number, ultimaLinha: number, colunas: number, xSplit = 0): void {
  sheet.views = [{ state: "frozen", ySplit: linhaCabecalho, xSplit }];
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

function tituloDeSecao(sheet: ExcelJS.Worksheet, linha: number, texto: string, colunas: number): void {
  sheet.mergeCells(linha, 1, linha, colunas);
  const cell = sheet.getCell(linha, 1);
  cell.value = texto;
  cell.font = { bold: true, size: 12, color: { argb: `FF${COR.navy}` } };
  cell.fill = SECTION_FILL;
}

function formatar(row: ExcelJS.Row, formatos: Readonly<Record<number, string>>): void {
  for (const [coluna, formato] of Object.entries(formatos)) {
    row.getCell(Number(coluna)).numFmt = formato;
  }
}

/** Ordena um recorte agregado do maior faturamento para o menor (ordenar não é agregar). */
function porFaturamento(linhas: readonly AbcBreakdownRow[]): AbcBreakdownRow[] {
  return [...linhas].sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0));
}

export interface AbcWorkbookInput {
  curves: Readonly<Record<AbcCriterionKey, readonly AbcAnalysisRow[]>>;
  breakdowns: Readonly<Record<AbcDimension, readonly AbcBreakdownRow[]>>;
  byAccount: readonly SkuAccountSales[];
  accounts: readonly AccountColumn[];
  organizationName: string | null;
  recorte: string;
  dayCount: number;
  generatedAt: Date;
}

// ---------------------------------------------------------------------------
// Painel
// ---------------------------------------------------------------------------

const PAINEL = "Painel";
const PAINEL_COLUNAS = 12;

function painel(workbook: ExcelJS.Workbook, input: AbcWorkbookInput, contexto: Contexto): ChartSpec[] {
  const sheet = workbook.addWorksheet(PAINEL, {
    properties: { tabColor: { argb: `FF${COR.navy}` } },
    views: [{ showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  sheet.columns = Array.from({ length: PAINEL_COLUNAS }, (_, i) => ({ width: i === 0 ? 22 : 14 }));
  topo(sheet, PAINEL_COLUNAS, "Curva ABC — painel", contexto);

  const fat = summarizeCurve("faturamento", input.curves.faturamento);
  const uni = summarizeCurve("unidades", input.curves.unidades);
  const ped = summarizeCurve("pedidos", input.curves.pedidos);

  // --- indicadores (linhas 5 a 7), seis blocos de duas colunas ---
  const indicadores: { rotulo: string; valor: number | null; formato: string; anterior: number | null; anteriorFormato: string }[] = [
    { rotulo: "Faturamento", valor: fat.total, formato: CURRENCY, anterior: fat.prevTotal, anteriorFormato: CURRENCY },
    { rotulo: "Unidades vendidas", valor: uni.total, formato: INTEGER, anterior: uni.prevTotal, anteriorFormato: INTEGER },
    { rotulo: "Pedidos", valor: ped.total, formato: INTEGER, anterior: ped.prevTotal, anteriorFormato: INTEGER },
    {
      rotulo: "Ticket médio",
      valor: razao(fat.total, ped.total),
      formato: CURRENCY,
      anterior: razao(fat.prevTotal, ped.prevTotal),
      anteriorFormato: CURRENCY,
    },
    { rotulo: "SKUs com venda", valor: fat.totalSkus, formato: INTEGER, anterior: null, anteriorFormato: INTEGER },
    { rotulo: "SKUs sem Full", valor: fat.withoutFull, formato: INTEGER, anterior: null, anteriorFormato: INTEGER },
  ];

  indicadores.forEach((kpi, i) => {
    const coluna = 1 + i * 2;
    sheet.mergeCells(5, coluna, 5, coluna + 1);
    sheet.mergeCells(6, coluna, 6, coluna + 1);
    sheet.mergeCells(7, coluna, 7, coluna + 1);

    const rotulo = sheet.getCell(5, coluna);
    rotulo.value = kpi.rotulo.toUpperCase();
    rotulo.font = { size: 9, bold: true, color: { argb: i === 0 ? "FFFFFFFF" : "FF6B7280" } };

    const valor = sheet.getCell(6, coluna);
    valor.value = kpi.valor;
    valor.numFmt = kpi.formato;
    valor.font = { size: 16, bold: true, color: { argb: i === 0 ? "FFFFFFFF" : `FF${COR.navy}` } };

    const detalhe = sheet.getCell(7, coluna);
    const v = variacao(kpi.valor, kpi.anterior);
    // Abaixo de 0,05% a variação some no arredondamento: neutra, sem seta nem cor.
    const estavel = v !== null && Math.abs(v) < 0.0005;
    detalhe.value =
      kpi.anterior === null
        ? i === 4
          ? `▲${String(fat.movement.subiu)} ▼${String(fat.movement.caiu)} · ${String(fat.movement.novo)} novos`
          : null
        : `${v === null ? "—" : `${estavel ? "=" : v > 0 ? "▲" : "▼"} ${(Math.abs(v) * 100).toFixed(1).replace(".", ",")}%`} vs anterior`;
    detalhe.font = {
      size: 9,
      bold: v !== null && !estavel,
      color: {
        argb: i === 0 ? "FFFFFFFF" : v === null || estavel ? "FF6B7280" : v > 0 ? `FF${COR.verde}` : `FF${COR.linha}`,
      },
    };

    for (let linha = 5; linha <= 7; linha += 1) {
      for (const c of [coluna, coluna + 1]) {
        const cell = sheet.getCell(linha, c);
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: i === 0 ? `FF${COR.navy}` : "FFF7F8FC" } };
        cell.alignment = { horizontal: "left", vertical: "middle", indent: 1 };
      }
    }
  });
  sheet.getRow(6).height = 26;

  // --- as tabelas que alimentam os gráficos, abaixo da área dos gráficos ---
  const charts: ChartSpec[] = [];
  let r = 88;
  const notaGraficos = sheet.getCell(9, 1);
  notaGraficos.value = "Os gráficos abaixo leem as tabelas no fim desta aba (a partir da linha 88).";
  notaGraficos.font = { italic: true, size: 9, color: { argb: "FF6B7280" } };

  // 1. Resumo por classe
  tituloDeSecao(sheet, r, "Resumo por classe (as três curvas)", PAINEL_COLUNAS);
  r += 1;
  cabecalho(sheet, r, ["Classe", "SKUs (fat.)", "Faturamento", "% fat.", "SKUs (unid.)", "Unidades", "% unid.", "SKUs (ped.)", "Pedidos", "% ped."]);
  r += 1;
  const resumoInicio = r;

  for (const classe of ["A", "B", "C"] as const) {
    const f = fat.classes.find((c) => c.classe === classe);
    const u = uni.classes.find((c) => c.classe === classe);
    const p = ped.classes.find((c) => c.classe === classe);
    const row = sheet.getRow(r);
    row.values = [
      `Classe ${classe}`,
      f?.skus ?? null,
      f?.valor ?? null,
      f?.participacao ?? null,
      u?.skus ?? null,
      u?.valor ?? null,
      u?.participacao ?? null,
      p?.skus ?? null,
      p?.valor ?? null,
      p?.participacao ?? null,
    ];
    pintarClasse(row.getCell(1), classe);
    formatar(row, { 2: INTEGER, 3: CURRENCY, 4: PERCENT, 5: INTEGER, 6: INTEGER, 7: PERCENT, 8: INTEGER, 9: INTEGER, 10: PERCENT });
    r += 1;
  }

  const resumoFim = r - 1;
  const total = sheet.getRow(r);
  total.values = ["Total", fat.totalSkus, fat.total, fat.classes.length === 0 ? null : 1, uni.totalSkus, uni.total, uni.classes.length === 0 ? null : 1, ped.totalSkus, ped.total, ped.classes.length === 0 ? null : 1];
  total.font = { bold: true };
  formatar(total, { 2: INTEGER, 3: CURRENCY, 4: PERCENT, 5: INTEGER, 6: INTEGER, 7: PERCENT, 8: INTEGER, 9: INTEGER, 10: PERCENT });
  r += 2;

  const classesRotulos = ["Classe A", "Classe B", "Classe C"];

  if (fat.classes.length > 0) {
    charts.push({
      sheet: PAINEL,
      from: { col: 6, row: 9 },
      to: { col: 12, row: 27 },
      type: "doughnut",
      title: "Faturamento por classe",
      series: [
        {
          name: "Faturamento",
          categoriesRef: rangeRef(PAINEL, 1, resumoInicio, resumoFim),
          categories: classesRotulos,
          valuesRef: rangeRef(PAINEL, 3, resumoInicio, resumoFim),
          values: fat.classes.map((c) => c.valor),
          color: COR.a,
          pointColors: [COR.a, COR.b, COR.c],
        },
      ],
    });
  }

  // 2. Movimento de classe e a matriz de migração
  tituloDeSecao(sheet, r, "Movimento de classe no faturamento (contra o período anterior de mesmo tamanho)", PAINEL_COLUNAS);
  r += 1;
  cabecalho(sheet, r, ["Movimento", "SKUs"]);
  r += 1;
  const movimentoInicio = r;
  const movimentos = [
    ["Subiu de classe", fat.movement.subiu],
    ["Caiu de classe", fat.movement.caiu],
    ["Manteve a classe", fat.movement.manteve],
    ["Novo (sem venda antes)", fat.movement.novo],
  ] as const;

  for (const [rotulo, valor] of movimentos) {
    const row = sheet.getRow(r);
    row.values = [rotulo, valor];
    row.getCell(2).numFmt = INTEGER;
    r += 1;
  }

  const movimentoFim = r - 1;
  charts.push({
    sheet: PAINEL,
    from: { col: 6, row: 66 },
    to: { col: 12, row: 84 },
    type: "column",
    title: "Movimento de classe (SKUs)",
    series: [
      {
        name: "SKUs",
        categoriesRef: rangeRef(PAINEL, 1, movimentoInicio, movimentoFim),
        categories: movimentos.map(([rotulo]) => rotulo),
        valuesRef: rangeRef(PAINEL, 2, movimentoInicio, movimentoFim),
        values: movimentos.map(([, valor]) => valor),
        color: COR.navy,
      },
    ],
    valueFormat: INTEGER,
  });
  r += 1;

  const matriz = migrationMatrix(input.breakdowns.migracao);
  const matrizTitulo = sheet.getCell(r, 1);
  matrizTitulo.value = "Matriz de migração — linha: classe no período anterior; coluna: classe agora (SKUs)";
  matrizTitulo.font = { bold: true, size: 10 };
  r += 1;
  cabecalho(sheet, r, ["Antes \\ Agora", ...matriz.columns]);
  r += 1;

  matriz.rows.forEach((de, i) => {
    const row = sheet.getRow(r);
    row.values = [de === "Novo" ? "Sem venda antes" : `Era ${de}`, ...(matriz.cells[i] ?? [])];

    for (let c = 2; c <= matriz.columns.length + 1; c += 1) {
      row.getCell(c).numFmt = INTEGER;
      row.getCell(c).alignment = { horizontal: "center" };

      // A diagonal (manteve) em destaque; acima dela subiu, abaixo caiu.
      if (c - 2 === i) row.getCell(c).fill = SECTION_FILL;
    }

    r += 1;
  });
  r += 1;

  // 3. Pareto e top SKUs
  tituloDeSecao(sheet, r, "Os 30 SKUs que mais faturaram (Pareto)", PAINEL_COLUNAS);
  r += 1;
  cabecalho(sheet, r, ["SKU", "Produto", "Classe", "Faturamento", "% do total", "% acumulado", "Variação vs anterior"]);
  r += 1;
  const paretoInicio = r;
  const top = input.curves.faturamento.slice(0, 30);

  for (const linha of top) {
    const row = sheet.getRow(r);
    row.values = [
      linha.sku,
      linha.title ?? "Produto sem título",
      linha.abc_class,
      linha.metric_value,
      linha.metric_share / 100,
      linha.cumulative_share / 100,
      variacao(linha.metric_value, linha.prev_metric_value),
    ];
    pintarClasse(row.getCell(3), linha.abc_class);
    formatar(row, { 4: CURRENCY, 5: PERCENT, 6: PERCENT, 7: PERCENT_SIGNED });
    r += 1;
  }

  const paretoFim = r - 1;

  if (top.length > 0) {
    charts.push({
      sheet: PAINEL,
      from: { col: 0, row: 9 },
      to: { col: 6, row: 27 },
      type: "pareto",
      title: "Pareto: faturamento e % acumulado (top 30)",
      series: [
        {
          name: "Faturamento",
          categoriesRef: rangeRef(PAINEL, 1, paretoInicio, paretoFim),
          categories: top.map((l) => l.sku),
          valuesRef: rangeRef(PAINEL, 4, paretoInicio, paretoFim),
          values: top.map((l) => l.metric_value),
          color: COR.navy,
        },
        {
          name: "% acumulado",
          categoriesRef: rangeRef(PAINEL, 1, paretoInicio, paretoFim),
          categories: top.map((l) => l.sku),
          valuesRef: rangeRef(PAINEL, 6, paretoInicio, paretoFim),
          values: top.map((l) => l.cumulative_share / 100),
          color: COR.linha,
        },
      ],
      valueFormat: CURRENCY_AXIS,
    });

    const top15 = Math.min(15, top.length);
    charts.push({
      sheet: PAINEL,
      from: { col: 0, row: 47 },
      to: { col: 6, row: 65 },
      type: "bar",
      title: `Top ${String(top15)} SKUs por faturamento`,
      series: [
        {
          name: "Faturamento",
          categoriesRef: rangeRef(PAINEL, 1, paretoInicio, paretoInicio + top15 - 1),
          categories: top.slice(0, top15).map((l) => l.sku),
          valuesRef: rangeRef(PAINEL, 4, paretoInicio, paretoInicio + top15 - 1),
          values: top.slice(0, top15).map((l) => l.metric_value),
          color: COR.navy,
        },
      ],
      valueFormat: CURRENCY_AXIS,
    });
  }

  r += 1;

  // 4. Recortes agregados: conta, mês, marca, categoria
  const recorte = (
    titulo: string,
    rotuloDaChave: string,
    linhas: readonly AbcBreakdownRow[],
    rotular: (l: AbcBreakdownRow) => string,
    grafico: { from: { col: number; row: number }; to: { col: number; row: number }; titulo: string; tipo: "bar" | "column"; limite: number } | null,
  ): void => {
    tituloDeSecao(sheet, r, titulo, PAINEL_COLUNAS);
    r += 1;
    cabecalho(sheet, r, [rotuloDaChave, "Faturamento", "Unidades", "Pedidos", "SKUs com venda", "Ticket médio", "Fat. classe A", "Fat. classe B", "Fat. classe C"]);
    r += 1;
    const inicio = r;

    for (const linha of linhas) {
      const row = sheet.getRow(r);
      row.values = [
        rotular(linha),
        linha.revenue,
        linha.units,
        linha.orders,
        linha.sku_count,
        razao(linha.revenue, linha.orders),
        linha.class_a_value,
        linha.class_b_value,
        linha.class_c_value,
      ];
      formatar(row, { 2: CURRENCY, 3: INTEGER, 4: INTEGER, 5: INTEGER, 6: CURRENCY, 7: CURRENCY, 8: CURRENCY, 9: CURRENCY });
      r += 1;
    }

    if (linhas.length === 0) {
      sheet.getCell(r, 1).value = "Sem venda no recorte.";
      r += 1;
    }

    if (grafico !== null && linhas.length > 0) {
      const n = Math.min(grafico.limite, linhas.length);
      const fim = inicio + n - 1;
      const categorias = linhas.slice(0, n).map(rotular);
      const serie = (nome: string, coluna: number, cor: string, valores: (number | null)[]) => ({
        name: nome,
        categoriesRef: rangeRef(PAINEL, 1, inicio, fim),
        categories: categorias,
        valuesRef: rangeRef(PAINEL, coluna, inicio, fim),
        values: valores,
        color: cor,
      });
      const fatia = linhas.slice(0, n);

      charts.push({
        sheet: PAINEL,
        from: grafico.from,
        to: grafico.to,
        type: grafico.tipo,
        title: grafico.titulo,
        stacked: true,
        series: [
          serie("Classe A", 7, COR.a, fatia.map((l) => l.class_a_value)),
          serie("Classe B", 8, COR.b, fatia.map((l) => l.class_b_value)),
          serie("Classe C", 9, COR.c, fatia.map((l) => l.class_c_value)),
        ],
        valueFormat: CURRENCY_AXIS,
      });
    }

    r += 1;
  };

  recorte("Por conta", "Conta", porFaturamento(input.breakdowns.conta), (l) => l.group_label, {
    from: { col: 0, row: 28 },
    to: { col: 6, row: 46 },
    titulo: "Faturamento por conta e classe",
    tipo: "bar",
    limite: 12,
  });
  recorte("Mês a mês", "Mês", input.breakdowns.mes, (l) => monthLabel(l.group_key), {
    from: { col: 6, row: 28 },
    to: { col: 12, row: 46 },
    titulo: "Faturamento mês a mês, por classe",
    tipo: "column",
    limite: 24,
  });
  recorte("Por marca", "Marca", porFaturamento(input.breakdowns.marca), (l) => l.group_label, {
    from: { col: 6, row: 47 },
    to: { col: 12, row: 65 },
    titulo: "Top 10 marcas por faturamento",
    tipo: "bar",
    limite: 10,
  });
  recorte("Por categoria", "Categoria", porFaturamento(input.breakdowns.categoria), (l) => l.group_label, {
    from: { col: 0, row: 66 },
    to: { col: 6, row: 84 },
    titulo: "Top 10 categorias por faturamento",
    tipo: "bar",
    limite: 10,
  });

  rodape(sheet, r + 1, PAINEL_COLUNAS, input.generatedAt);

  return charts;
}

// ---------------------------------------------------------------------------
// Consolidado
// ---------------------------------------------------------------------------

function consolidado(workbook: ExcelJS.Workbook, input: AbcWorkbookInput, contexto: Contexto): void {
  const sheet = workbook.addWorksheet("Consolidado", { properties: { tabColor: { argb: "FF3F44A6" } } });
  const colunas = [
    ["Posição", 8, null],
    ["SKU", 18, null],
    ["Produto", 46, null],
    ["Tipo", 9, null],
    ["Marca", 16, null],
    ["Categoria", 18, null],
    ["Classe fat.", 9, null],
    ["Classe unid.", 9, null],
    ["Classe ped.", 9, null],
    ["Classes (F/U/P)", 10, null],
    ["Faturamento (R$)", 16, CURRENCY],
    ["% do faturamento", 12, PERCENT],
    ["% acumulado", 12, PERCENT],
    ["Unidades", 11, INTEGER],
    ["Pedidos", 11, INTEGER],
    ["Ticket médio (R$)", 14, CURRENCY],
    ["Preço médio por unidade (R$)", 15, CURRENCY],
    ["Faturamento anterior (R$)", 16, CURRENCY],
    ["Variação", 11, PERCENT_SIGNED],
    ["Classe anterior", 10, null],
    ["Movimento", 11, null],
    ["Custo unitário (R$)", 14, CURRENCY],
    ["Estoque local", 11, INTEGER],
    ["Estoque Full", 11, INTEGER],
    ["Estoque total", 11, INTEGER],
    ["Valor do estoque (R$)", 15, CURRENCY],
    ["Cobertura (dias)", 11, DECIMAL],
    ["Sem Full", 9, null],
  ] as const;
  sheet.columns = colunas.map(([, width]) => ({ width }));
  let c = topo(sheet, colunas.length, "Curva ABC — consolidado por SKU", contexto);
  const linhaCabecalho = c;
  cabecalho(sheet, c, colunas.map(([titulo]) => titulo));
  c += 1;
  const primeira = c;

  consolidateCurves(input.curves).forEach((linha, indice) => {
    const row = sheet.getRow(c);
    row.values = [
      indice + 1,
      linha.sku,
      linha.title,
      linha.kind,
      linha.brand,
      linha.category,
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
      linha.prevRevenue,
      linha.revenueChange,
      linha.prevClass,
      linha.movement,
      linha.purchaseCost,
      linha.localStock,
      linha.fullStock,
      linha.totalStock,
      linha.stockValue,
      linha.coverageDays,
      linha.fullStock === 0 ? "Sim" : "Não",
    ];
    pintarClasse(row.getCell(7), linha.classRevenue);
    pintarClasse(row.getCell(8), linha.classUnits);
    pintarClasse(row.getCell(9), linha.classOrders);
    pintarClasse(row.getCell(20), linha.prevClass);
    row.getCell(10).alignment = { horizontal: "center" };
    colunas.forEach(([, , formato], i) => {
      if (formato !== null) row.getCell(i + 1).numFmt = formato;
    });
    c += 1;
  });

  const ultima = c - 1;

  if (ultima >= primeira) {
    // Barra de dados no faturamento e escala de cor na variação e na cobertura:
    // o olho acha o grande, o que cresceu e o que vai faltar sem ordenar nada.
    sheet.addConditionalFormatting({
      ref: `K${String(primeira)}:K${String(ultima)}`,
      rules: [{ type: "dataBar", priority: 1, cfvo: [{ type: "min" }, { type: "max" }], color: { argb: "FF6E7FD1" } } as ExcelJS.DataBarRuleType],
    });
    sheet.addConditionalFormatting({
      ref: `S${String(primeira)}:S${String(ultima)}`,
      rules: [
        {
          type: "colorScale",
          priority: 2,
          cfvo: [{ type: "num", value: -0.5 }, { type: "num", value: 0 }, { type: "num", value: 0.5 }],
          color: [{ argb: "FFF8696B" }, { argb: "FFFFFFFF" }, { argb: "FF63BE7B" }],
        },
      ],
    });
    sheet.addConditionalFormatting({
      ref: `AA${String(primeira)}:AA${String(ultima)}`,
      rules: [
        {
          type: "colorScale",
          priority: 3,
          cfvo: [{ type: "num", value: 15 }, { type: "num", value: 45 }, { type: "num", value: 120 }],
          color: [{ argb: "FFF8696B" }, { argb: "FFFFEB84" }, { argb: "FF63BE7B" }],
        },
      ],
    });
  }

  finalizarTabela(sheet, linhaCabecalho, ultima, colunas.length, 3);
  rodape(sheet, c + 1, colunas.length, input.generatedAt);
}

// ---------------------------------------------------------------------------
// Uma aba por critério
// ---------------------------------------------------------------------------

function curvaDoCriterio(
  workbook: ExcelJS.Workbook,
  criterio: (typeof CRITERIOS)[number],
  linhas: readonly AbcAnalysisRow[],
  input: AbcWorkbookInput,
  contexto: Contexto,
): void {
  const sheet = workbook.addWorksheet(criterio.aba);
  const colunas = [
    ["Posição", 8],
    ["Classe", 8],
    ["SKU", 18],
    ["Produto", 46],
    ["Marca", 16],
    ["Categoria", 18],
    [criterio.rotulo, 16],
    ["% do total", 11],
    ["% acumulado", 12],
    ["Período anterior", 15],
    ["Variação", 11],
    ["Classe anterior", 10],
    ["Movimento", 11],
    ["Estoque Full", 11],
  ] as const;
  sheet.columns = colunas.map(([, width]) => ({ width }));
  let l = topo(sheet, colunas.length, `Curva ABC por ${criterio.rotulo.toLowerCase()}`, contexto);
  const linhaCabecalho = l;
  cabecalho(sheet, l, colunas.map(([titulo]) => titulo));
  l += 1;

  linhas.forEach((linha, indice) => {
    const row = sheet.getRow(l);
    row.values = [
      indice + 1,
      linha.abc_class,
      linha.sku,
      linha.title ?? "Produto sem título",
      linha.supplier_brand,
      linha.category,
      linha.metric_value,
      linha.metric_share / 100,
      linha.cumulative_share / 100,
      linha.prev_metric_value,
      variacao(linha.metric_value, linha.prev_metric_value),
      linha.prev_abc_class,
      movementLabel(linha.movement),
      linha.full_stock,
    ];
    pintarClasse(row.getCell(2), linha.abc_class);
    pintarClasse(row.getCell(12), linha.prev_abc_class);
    formatar(row, { 7: criterio.formato, 8: PERCENT, 9: PERCENT, 10: criterio.formato, 11: PERCENT_SIGNED, 14: INTEGER });
    l += 1;
  });

  finalizarTabela(sheet, linhaCabecalho, l - 1, colunas.length, 4);
  rodape(sheet, l + 1, colunas.length, input.generatedAt);
}

// ---------------------------------------------------------------------------
// Por conta
// ---------------------------------------------------------------------------

function porConta(workbook: ExcelJS.Workbook, input: AbcWorkbookInput, contexto: Contexto): void {
  const sheet = workbook.addWorksheet("Por conta");
  const contas = input.accounts;
  const titulos = [
    "SKU",
    "Produto",
    "Classe fat.",
    "Faturamento total (R$)",
    ...contas.map((a) => `Fat. ${a.label} (R$)`),
    "Unidades total",
    ...contas.map((a) => `Unid. ${a.label}`),
  ];
  sheet.columns = titulos.map((_, i) => ({ width: i === 1 ? 46 : i === 0 ? 18 : 15 }));
  let l = topo(sheet, titulos.length, "Venda de cada SKU em cada conta (todas as contas, mesmo com uma conta escolhida)", contexto);
  const linhaCabecalho = l;
  cabecalho(sheet, l, titulos);
  l += 1;

  for (const linha of pivotByAccount(consolidateCurves(input.curves), input.byAccount, contas)) {
    const row = sheet.getRow(l);
    row.values = [linha.sku, linha.title, linha.classRevenue, linha.revenue, ...linha.revenueByAccount, linha.units, ...linha.unitsByAccount];
    pintarClasse(row.getCell(3), linha.classRevenue);

    for (let c = 4; c <= 4 + contas.length; c += 1) row.getCell(c).numFmt = CURRENCY;
    for (let c = 5 + contas.length; c <= titulos.length; c += 1) row.getCell(c).numFmt = INTEGER;

    row.getCell(4).font = { bold: true };
    row.getCell(5 + contas.length).font = { bold: true };
    l += 1;
  }

  finalizarTabela(sheet, linhaCabecalho, l - 1, titulos.length, 2);
  rodape(sheet, l + 1, titulos.length, input.generatedAt);
}

// ---------------------------------------------------------------------------
// Glossário
// ---------------------------------------------------------------------------

function glossario(workbook: ExcelJS.Workbook, input: AbcWorkbookInput, contexto: Contexto): void {
  const sheet = workbook.addWorksheet("Glossário");
  sheet.columns = [{ width: 28 }, { width: 110 }];
  let r = topo(sheet, 2, "Como ler esta planilha", contexto);

  const termos: readonly (readonly [string, string])[] = [
    ["Classe A / B / C", "Os SKUs em ordem decrescente do critério: A até 80% do total acumulado, B de 80% a 95%, C o resto. Calculada dentro do recorte (conta, marca, categoria, tipo), não é a fatia do recorte na curva geral."],
    ["Classes (F/U/P)", "A classe do SKU em faturamento, unidades e pedidos, nessa ordem. \"AAB\" = A em faturamento e unidades, B em pedidos; \"-\" onde o SKU não entrou na curva."],
    ["Período anterior", `Os ${String(input.dayCount)} dias imediatamente antes do período, no mesmo recorte. É a base da variação e do movimento de classe.`],
    ["Variação", "(período − anterior) ÷ anterior. Vazia quando o SKU não vendeu no período anterior: crescimento sobre zero não é número."],
    ["Movimento", "Subiu (ex.: B → A), caiu (A → B), manteve, ou novo (sem venda no período anterior)."],
    ["Matriz de migração", "Quantos SKUs foram de cada classe no período anterior para cada classe agora. \"Sem venda\" = vendia antes e parou."],
    ["Ticket médio", "Faturamento ÷ pedidos. Um pedido com dois SKUs conta nos dois."],
    ["Estoque local", "Saldo da loja (organização inteira, não segue a conta). Vazio = sem saldo registrado; kits não têm saldo próprio."],
    ["Estoque Full", "Soma dos saldos do Full recapturados nos últimos 3 dias, das contas do recorte."],
    ["Valor do estoque", "Custo unitário × (estoque local positivo + Full)."],
    ["Cobertura (dias)", "Quantos dias o estoque (local + Full) dura na venda média diária do período."],
    ["Fonte", "Vendas diárias por SKU (pedidos pagos), as mesmas da tela /curva-abc. Uma venda só entra quando tem SKU vinculado (D-423)."],
    ["Filtros de linha", "Classe, estoque, movimento e busca da tela NÃO recortam o arquivo: use o filtro automático das colunas."],
  ];

  for (const [termo, explicacao] of termos) {
    const row = sheet.getRow(r);
    row.values = [termo, explicacao];
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
    row.getCell(1).alignment = { vertical: "top" };
    r += 1;
  }

  rodape(sheet, r + 1, 2, input.generatedAt);
}

// ---------------------------------------------------------------------------

export async function buildAbcWorkbook(input: AbcWorkbookInput): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Speed Bikers Gestão";
  workbook.created = input.generatedAt;

  const contexto: Contexto = { organizationName: input.organizationName, recorte: input.recorte };

  const charts = painel(workbook, input, contexto);
  consolidado(workbook, input, contexto);

  for (const criterio of CRITERIOS) {
    curvaDoCriterio(workbook, criterio, input.curves[criterio.key], input, contexto);
  }

  porConta(workbook, input, contexto);
  glossario(workbook, input, contexto);

  const buffer = await workbook.xlsx.writeBuffer();

  return addChartsToXlsx(buffer, charts);
}
