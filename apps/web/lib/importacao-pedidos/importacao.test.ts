import { describe, expect, it } from "vitest";

import { classificarAba, interpretarQuantidade, montarLinhas } from "./colunas";
import { lerAba, lerPlanilha, lerSharedStrings, lerWorkbook, type ZipLeitura } from "./xlsx";

/**
 * A leitura e a classificação da importação de pedidos anteriores (D-764), com
 * XML no formato do Excel e o layout descrito do "Controle de chegada": código,
 * EAN, NCM, descrição, colunas de quantidade por referência e colunas de
 * quantidade SEM cabeçalho. As planilhas reais ficam fora do repositório.
 */

const SHARED = `<sst><si><t>CÓDIGO</t></si><si><t>EAN</t></si><si><t>NCM</t></si><si><t>DESCRIÇÃO</t></si>
<si><t>30632-1</t></si><si><t>31011</t></si><si><t>OBS</t></si><si><t>007BFD50</t></si>
<si><r><t>PASTILHA </t></r><r><t>FREIO &amp; DISCO</t></r></si><si><t>200 + 200</t></si><si><t>NÃO VENDE</t></si>
<si><t>KPP08</t></si><si><t>VALOR FOB</t></si><si><t>TOTAL</t></si></sst>`;

function c(ref: string, valor: string, tipo: "s" | "n" | "str" = "n", formula?: string): string {
  const f = formula === undefined ? "" : `<f>${formula}</f>`;

  return tipo === "n" ? `<c r="${ref}">${f}<v>${valor}</v></c>` : `<c r="${ref}" t="${tipo}">${f}<v>${valor}</v></c>`;
}

const ABA = `<worksheet><sheetData>
<row r="1">${c("A1", "0", "s")}${c("B1", "1", "s")}${c("C1", "2", "s")}${c("D1", "3", "s")}${c("E1", "4", "s")}${c("F1", "5", "s")}<c r="G1"/>${c("H1", "6", "s")}${c("I1", "12", "s")}</row>
<row r="2">${c("A2", "7", "s")}${c("B2", "7891000315507")}${c("C2", "87149990")}${c("D2", "8", "s")}${c("E2", "1000")}${c("F2", "9", "s")}${c("G2", "300")}${c("H2", "10", "s")}${c("I2", "1.25")}</row>
<row r="3">${c("A3", "11", "s")}${c("D3", "8", "s")}${c("E3", "", "n", "E2*2")}${c("G3", "50")}</row>
<row r="4">${c("D4", "13", "s")}${c("E4", "1000")}</row>
<row r="5"><c r="A5" t="inlineStr"><is><t>BAU-01</t></is></c>${c("D5", "8", "s")}${c("E5", "0")}</row>
</sheetData></worksheet>`;

describe("leitura do .xlsx", () => {
  it("texto rico, entidades e texto preservado (zero à esquerda, '200 + 200')", () => {
    const shared = lerSharedStrings(SHARED);
    const { grade } = lerAba(ABA, shared);

    expect(grade.get(2)?.get("A")?.texto).toBe("007BFD50");
    expect(grade.get(2)?.get("D")?.texto).toBe("PASTILHA FREIO & DISCO");
    expect(grade.get(2)?.get("F")?.texto).toBe("200 + 200");
    expect(grade.get(2)?.get("E")).toMatchObject({ texto: "1000", numerica: true });
    // Fórmula sem valor em cache: texto vazio com a fórmula, nunca um número calculado.
    expect(grade.get(3)?.get("E")).toMatchObject({ texto: "", formula: "E2*2" });
    expect(grade.get(5)?.get("A")?.texto).toBe("BAU-01");
  });

  it("abre só o workbook, as strings e as abas pedidas — nunca xl/media", async () => {
    const pedidas: string[] = [];
    const partes: Record<string, string> = {
      "xl/workbook.xml": `<workbook><sheets><sheet name="PEÇAS" sheetId="1" r:id="rId1"/><sheet name="BAU" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
      "xl/sharedStrings.xml": SHARED,
      "xl/worksheets/sheet1.xml": ABA,
      "xl/worksheets/sheet2.xml": ABA,
    };
    const zip: ZipLeitura = {
      texto(caminho) {
        pedidas.push(caminho);

        return Promise.resolve(partes[caminho] ?? null);
      },
    };

    const lida = await lerPlanilha(zip, ["BAU"]);

    expect(lida.todas).toEqual(["PEÇAS", "BAU"]);
    expect(lida.abas.map((a) => a.nome)).toEqual(["BAU"]);
    expect(pedidas.some((p) => p.includes("media"))).toBe(false);
    expect(pedidas).not.toContain("xl/worksheets/sheet1.xml");
    expect(lerWorkbook(partes["xl/workbook.xml"] ?? "", partes["xl/_rels/workbook.xml.rels"] ?? "")[1]?.caminho).toBe("xl/worksheets/sheet2.xml");
  });
});

describe("classificação das colunas", () => {
  const aba = { nome: "PEÇAS", grade: lerAba(ABA, lerSharedStrings(SHARED)).grade, cortada: false };
  const cls = classificarAba(aba);
  const papel = (col: string) => cls.colunas.find((x) => x.coluna === col);

  it("reconhece código, EAN, NCM, descrição e observação pelo cabeçalho", () => {
    expect(cls.linhaCabecalho).toBe(1);
    expect(papel("A")?.papel).toBe("CODIGO");
    expect(papel("B")?.papel).toBe("EAN");
    expect(papel("C")?.papel).toBe("NCM");
    expect(papel("D")?.papel).toBe("DESCRICAO");
    expect(papel("H")?.papel).toBe("OBSERVACAO");
  });

  it("quantidade por referência; sem cabeçalho, a referência fica a informar; valor é ignorado", () => {
    expect(papel("E")).toMatchObject({ papel: "QUANTIDADE", referencia: "30632-1" });
    expect(papel("F")).toMatchObject({ papel: "QUANTIDADE", referencia: "31011" });
    expect(papel("G")).toMatchObject({ papel: "QUANTIDADE", referencia: null });
    expect(papel("I")?.papel).toBe("IGNORAR");
  });

  it("uma linha por quantidade preenchida, com a origem e a observação preservadas", () => {
    const linhas = montarLinhas(aba, cls);

    expect(linhas.find((l) => l.row === 2 && l.column === "E")).toMatchObject({
      code: "007BFD50",
      ean: "7891000315507",
      quantity: 1000,
      quantityNeedsConfirmation: false,
      reference: "30632-1",
      notes: "NÃO VENDE",
    });
    expect(linhas.find((l) => l.row === 2 && l.column === "F")).toMatchObject({
      quantityRaw: "200 + 200",
      quantity: 400,
      quantityNeedsConfirmation: true,
    });
    expect(linhas.find((l) => l.row === 2 && l.column === "G")).toMatchObject({ reference: null, quantity: 300 });
    expect(linhas.find((l) => l.row === 3 && l.column === "E")).toMatchObject({ quantityRaw: "=E2*2", quantity: null, quantityNeedsConfirmation: true });
    // Linha TOTAL sem código ainda tem descrição; zero não é quantidade.
    expect(linhas.some((l) => l.row === 5)).toBe(false);
  });
});

describe("cabeçalhos com duas palavras conhecidas", () => {
  it("'CÓDIGO DO PRODUTO' é código e 'DESCRIÇÃO DO PRODUTO' é descrição", () => {
    const xml = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>CÓDIGO DO PRODUTO</t></is></c><c r="B1" t="inlineStr"><is><t>DESCRIÇÃO DO PRODUTO</t></is></c><c r="C1" t="inlineStr"><is><t>QTD</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>X1</t></is></c><c r="B2" t="inlineStr"><is><t>Y</t></is></c><c r="C2"><v>5</v></c></row>
    </sheetData></worksheet>`;
    const cls = classificarAba({ nome: "A", grade: lerAba(xml, []).grade, cortada: false });

    expect(cls.colunas.map((x) => [x.coluna, x.papel, x.referencia])).toEqual([
      ["A", "CODIGO", null],
      ["B", "DESCRICAO", null],
      ["C", "QUANTIDADE", null],
    ]);
  });
});

describe("cabeçalho como referência", () => {
  it.each([
    ["30632-1", "30632-1"],
    ["JS31205", "JS31205"],
    ["PO-2026-001", "PO-2026-001"],
    ["ESTOQUE", null],
    ["QTD 2026", null],
  ])("%s → %s", (titulo, esperado) => {
    const xml = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>CÓDIGO</t></is></c><c r="B1" t="inlineStr"><is><t>${titulo}</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>X1</t></is></c><c r="B2"><v>5</v></c></row>
    </sheetData></worksheet>`;
    const col = classificarAba({ nome: "A", grade: lerAba(xml, []).grade, cortada: false }).colunas.find((c) => c.coluna === "B");

    expect(col).toMatchObject({ papel: "QUANTIDADE", referencia: esperado });
  });
});

describe("interpretarQuantidade", () => {
  it.each([
    ["120", true, 120, false],
    ["1.000", false, 1000, false],
    ["12,5", false, 12.5, false],
    ["200 + 200", false, 400, true],
    ["500 + 300 + 7", false, 807, true],
    ["S/MARGEM", false, null, true],
    ["0", true, null, true],
  ])("%s → %s", (bruto, numerica, valor, confirmar) => {
    expect(interpretarQuantidade(bruto, numerica)).toEqual({ valor, precisaConfirmar: confirmar });
  });
});
