import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { addChartsToXlsx, chartXml, columnLetter, escapeXml, rangeRef, type ChartSpec } from "./xlsx-charts";

async function planilha(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const dados = wb.addWorksheet("Dados & Cia");
  dados.addRows([
    ["Classe", "Valor"],
    ["A", 800],
    ["B", 150],
    ["C", 50],
  ]);
  wb.addWorksheet("Outra");

  return (await wb.xlsx.writeBuffer());
}

const serie = {
  name: "Faturamento <R$>",
  categoriesRef: rangeRef("Dados & Cia", 1, 2, 4),
  categories: ["A", "B", "C"],
  valuesRef: rangeRef("Dados & Cia", 2, 2, 4),
  values: [800, 150, null],
  color: "0E1259",
};

const coluna: ChartSpec = {
  sheet: "Dados & Cia",
  from: { col: 3, row: 1 },
  to: { col: 9, row: 15 },
  type: "column",
  title: "Classes & valores",
  series: [serie],
};

describe("referências e escape", () => {
  it("letra de coluna e referência com aspas na aba", () => {
    expect(columnLetter(1)).toBe("A");
    expect(columnLetter(27)).toBe("AA");
    expect(rangeRef("D'Ávila", 3, 2, 9)).toBe("'D''Ávila'!$C$2:$C$9");
    expect(escapeXml(`a<b>&"c'`)).toBe("a&lt;b&gt;&amp;&quot;c&apos;");
  });
});

describe("chartXml", () => {
  it("ponto nulo fica fora do cache: lacuna, nunca zero", () => {
    const xml = chartXml(coluna);

    expect(xml).toContain('<c:ptCount val="3"/><c:pt idx="0"><c:v>800</c:v></c:pt><c:pt idx="1"><c:v>150</c:v></c:pt></c:numCache>');
    expect(xml).toContain("Faturamento &lt;R$&gt;");
    expect(xml).toContain('<c:barDir val="col"/>');
  });

  it("Pareto: colunas no eixo principal e a linha no secundário, de 0 a 100%", () => {
    const xml = chartXml({ ...coluna, type: "pareto", series: [serie, { ...serie, name: "% acumulado" }] });

    expect(xml).toContain("<c:barChart>");
    expect(xml).toContain("<c:lineChart>");
    expect(xml).toContain('<c:axPos val="r"/>');
    expect(xml).toContain('<c:max val="1"/>');
  });

  it("Pareto sem a segunda série é erro de programação, não gráfico pela metade", () => {
    expect(() => chartXml({ ...coluna, type: "pareto" })).toThrow(/duas séries/);
  });

  it("rosca com cor por fatia e percentual no rótulo", () => {
    const xml = chartXml({ ...coluna, type: "doughnut", series: [{ ...serie, pointColors: ["0E1259", "F2A93B", "8FA3BF"] }] });

    expect(xml).toContain("<c:doughnutChart>");
    expect(xml.match(/<c:dPt>/g)).toHaveLength(3);
    expect(xml).toContain('<c:showPercent val="1"/>');
  });
});

describe("addChartsToXlsx", () => {
  it("registra desenho, gráficos, relações e tipos de conteúdo só na aba pedida", async () => {
    const saida = await addChartsToXlsx(await planilha(), [coluna, { ...coluna, type: "bar", title: "Barras" }]);
    const zip = await JSZip.loadAsync(saida);
    const arquivo = async (p: string) => (await zip.file(p)?.async("string")) ?? "";

    expect(await arquivo("xl/charts/chart1.xml")).toContain("Classes &amp; valores");
    expect(await arquivo("xl/charts/chart2.xml")).toContain('<c:barDir val="bar"/>');
    expect(await arquivo("xl/drawings/drawing1.xml")).toContain('r:id="rId2"');
    expect(await arquivo("xl/drawings/_rels/drawing1.xml.rels")).toContain("../charts/chart2.xml");
    expect(await arquivo("xl/worksheets/_rels/sheet1.xml.rels")).toContain("../drawings/drawing1.xml");

    const aba = await arquivo("xl/worksheets/sheet1.xml");
    // `<drawing>` depois de `pageMargins` e antes do fim: a ordem do esquema.
    expect(aba.indexOf("<drawing ")).toBeGreaterThan(aba.indexOf("<pageMargins"));
    expect(await arquivo("xl/worksheets/sheet2.xml")).not.toContain("<drawing ");

    const tipos = await arquivo("[Content_Types].xml");
    expect(tipos).toContain('PartName="/xl/charts/chart1.xml"');
    expect(tipos).toContain('PartName="/xl/drawings/drawing1.xml"');
  });

  it("aba inexistente é erro, não arquivo quebrado em silêncio", async () => {
    await expect(addChartsToXlsx(await planilha(), [{ ...coluna, sheet: "Nenhuma" }])).rejects.toThrow(/não encontrada/);
  });

  it("sem gráfico, devolve o mesmo conteúdo", async () => {
    const zip = await JSZip.loadAsync(await addChartsToXlsx(await planilha(), []));

    expect(Object.keys(zip.files).some((f) => f.startsWith("xl/charts/"))).toBe(false);
  });
});
