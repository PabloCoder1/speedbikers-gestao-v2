import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { classificar, classificarAba, ehListaDeEmbalagem, montarLinhas } from "./colunas";
import { lerData, numeroDeInvoice, referenciaPadrao } from "./invoice";
import { XlsInvalido, lerBiff, lerXls } from "./xls";
import type { Aba, Celula } from "./xlsx";

/**
 * Invoice, proforma e "sales confirmation" de fornecedor (D-767). Os layouts
 * reproduzem os documentos reais — uma linha por item, colunas sem título,
 * NCM, pedido (S/C), SKU, descrição, quantidade, unidade, "$", preço, "$",
 * valor — com códigos, pedidos e valores inventados. Os documentos reais ficam
 * fora do repositório.
 */

type Linha = Record<string, string | number>;

function aba(nome: string, linhas: Record<number, Linha>): Aba {
  const grade = new Map<number, Map<string, Celula>>();

  for (const [n, cols] of Object.entries(linhas)) {
    const l = new Map<string, Celula>();

    for (const [col, v] of Object.entries(cols)) {
      l.set(col, { texto: String(v), formula: null, numerica: typeof v === "number" });
    }
    grade.set(Number(n), l);
  }

  return { nome, grade, cortada: false };
}

/** A invoice comercial: S/C com vários pedidos no cabeçalho, pedido na coluna C, "$" solto em I e L. */
const COMERCIAL = aba("INV", {
  1: { A: "ORIGINAL", C: "供应商" },
  2: { A: "FORNECEDOR TESTE IMP. & EXP. CO.,LTD" },
  3: { F: "COMMERCIAL INVOICE", I: "发票号" },
  4: { I: "NO.", K: "PO900-2" },
  6: { I: "DATE", K: "Sep 28,2026" },
  8: { I: "S/C NO.", K: "PO100,PO200" },
  15: { A: "Marks & Numbers", C: "Quantities and Descriptions", I: "Unit Price", L: "Amount" },
  16: { A: "N/M", C: "MOTORCYCLE PARTS", I: "FOB  PORTO, CHINA" },
  17: { C: "B/L NO.：BLTESTE123" },
  18: { C: "Container/Seal No.:CONT1234567/LACRE99" },
  19: { A: 87141000, C: "PO100", D: "TST01", F: "PINÇA TRASEIRA DE TESTE", G: 200, H: "PCS", I: "$", J: 1.06, L: "$", M: 212 },
  20: { A: 87141000, C: "PO100", D: "TST02", F: "MANETE DE TESTE", G: 80, H: "PRS", I: "$", J: 0.91, L: "$", M: 72.8 },
  21: { A: 87141000, C: "PO100", D: "TST02", F: "MANETE DE TESTE", G: 20, H: "PRS", I: "$", J: 0.91, L: "$", M: 18.2 },
  22: { A: 84099112, C: "PO200", D: "TST03", F: "KIT CILINDRO DE TESTE", G: 504, H: "SETS", I: "$", J: 1.3, L: "$", M: 655.2 },
  23: { A: 90292010, C: "PO200", D: "TST04", F: "PAINEL DE TESTE", G: 60, H: "PCS", I: "$", J: 1.8, L: "$", M: 108 },
  25: { C: "TOTAL:", L: "$", M: 1066.2 },
});

/** Lista de embalagem da mesma invoice: quantidade, caixas, pesos — sem preço. */
const EMBALAGEM = aba("PL", {
  6: { F: "PACKING LIST(Weight Memo)" },
  18: { A: "GOODS", G: "QUANTITES", I: "PACKING", K: "G.W(kgs)", L: "N.W.(kgs)" },
  22: { A: "PO100", C: "TST01", E: "PINÇA TRASEIRA", G: 200, H: "PCS", I: 10, K: 260, L: 250 },
  23: { A: "PO100", C: "TST02", E: "MANETE", G: 100, H: "PRS", I: 2, K: 51.4, L: 49.4 },
});

/** "Sales confirmation": textos com quebra de linha, milhar com vírgula, sem S/C — o número do documento é o pedido. */
const PROFORMA = aba("Page 1", {
  4: { A: "SALES CONFIRMATION\r\n" },
  5: { A: "Messrs:\r\n", D: "CLIENTE TESTE\r\n", J: "Date\r\n", L: ":  26 Oct,2026\r\n" },
  6: { J: "No.\r\n", L: ":  SCX01080 / \r\n" },
  7: { J: "Cust# \r\n", L: ":  C0001\r\n" },
  13: { A: "Delivery:\r\n", D: "30.NOV.2026\r\n" },
  22: { A: "seq\r\n", B: "Item No/Cust_Item No\r\n", E: "Description\r\n", G: "Quantity\r\n", J: "Unit  Price\r\n", N: "Amount\r\n" },
  23: { G: "(USD$  FOB PORTO, CHINA)\r\n" },
  24: { A: "1\r\n", B: "X1002111465\r\n", E: "scooter de teste\r\nRoda 20\r\n", G: "243.00\r\n", I: "PCS\r\n", J: "$\r\n", K: "294.000\r\n", N: "$\r\n", O: "71,442.00\r\n" },
  25: { A: "2\r\n", B: "X1041020413\r\n", E: "bateria de teste 48V\r\n", G: "10.00\r\n", I: "PCS\r\n", J: "$\r\n", K: "84.000\r\n", N: "$\r\n", O: "840.00\r\n" },
  36: { E: "TOTAL:\r\n", G: "253\r\n", N: "$\r\n", O: "72,282.00\r\n" },
});

/** Proforma sem moeda, sem número, código no começo do modelo, colunas de tamanho e cor. */
const SEM_MOEDA = aba("INV", {
  4: { A: "Modelo", B: "Product pictures", E: "Size", G: "Color", J: "Unit price (FOB)", K: "Quantity", L: "Total" },
  5: { A: "TST-37 Com 2 encostos.", E: "37 L", G: "Black", J: 3, K: 670, L: 2010 },
  6: { A: "TST-45 Com 2 encostos.", E: "45L", G: "Black", J: 3.5, K: 670, L: 2345 },
  8: { J: "Total", L: 4355 },
});

/** O controle de chegada: uma coluna por pedido. Não pode virar invoice. */
const CONTROLE = aba("PEÇAS", {
  1: { A: "CÓDIGO", B: "EAN", C: "NCM", D: "DESCRIÇÃO", E: "30632-1", F: "31011" },
  2: { A: "TST01", B: "7891000315507", C: "87149990", D: "PINÇA", E: 200, F: 1 },
  3: { A: "TST02", D: "MANETE", E: 50, F: 50 },
  4: { A: "TST03", D: "PAINEL", E: 2, F: 3 },
});

describe("números, datas e referência da invoice", () => {
  it("lê número no formato americano das invoices", () => {
    expect(numeroDeInvoice("1.06")).toBe(1.06);
    expect(numeroDeInvoice("71,442.00\r\n")).toBe(71442);
    expect(numeroDeInvoice("$10.60")).toBe(10.6);
    expect(numeroDeInvoice("$ 16.60")).toBe(16.6);
    expect(numeroDeInvoice("PCS")).toBeNull();
    expect(numeroDeInvoice("200 + 200")).toBeNull();
  });

  it("lê as datas dos fornecedores e recusa a ambígua", () => {
    expect(lerData("Sep 28,2026")).toBe("2026-09-28");
    expect(lerData("26 Oct,2026")).toBe("2026-10-26");
    expect(lerData("30.NOV.2026")).toBe("2026-11-30");
    expect(lerData("30/10/2026")).toBe("2026-10-30");
    expect(lerData("03/04/2026")).toBeNull();
    expect(lerData("31/02/2026")).toBeNull();
  });

  it("a referência padrão nunca é inventada", () => {
    const doc = { tipo: null, numero: null, data: null, dataIso: null, pedidos: [], bl: null, container: null, entrega: null, entregaIso: null, moeda: null };

    expect(referenciaPadrao({ ...doc, pedidos: ["PO100"] }, "x.xlsx")).toBe("PO100");
    expect(referenciaPadrao({ ...doc, pedidos: ["PO100", "PO200"], numero: "PO900-2" }, "x.xlsx")).toBeNull();
    expect(referenciaPadrao({ ...doc, numero: "SCX01080" }, "x.xlsx")).toBe("SCX01080");
    expect(referenciaPadrao(doc, "A2026C701A-.xlsx")).toBe("A2026C701A");
    expect(referenciaPadrao(doc, "Proforma Invoice11.4.xls")).toBeNull();
  });
});

describe("invoice comercial", () => {
  const cls = classificar(COMERCIAL, "PO900-2INV&PL-.xlsx");
  const papel = (col: string) => cls.colunas.find((c) => c.coluna === col)?.papel;
  const linhas = montarLinhas(COMERCIAL, cls);

  it("reconhece as colunas sem título pelo conteúdo", () => {
    expect(cls.lista).toBeDefined();
    expect(cls.linhaCabecalho).toBe(15);
    expect([papel("A"), papel("C"), papel("D"), papel("F"), papel("G"), papel("H"), papel("J"), papel("M")]).toEqual([
      "NCM", "REFERENCIA", "CODIGO", "DESCRICAO", "QUANTIDADE", "UNIDADE", "PRECO", "VALOR",
    ]);
    // O "$" solto nem aparece: não é coluna de dado.
    expect(papel("I")).toBeUndefined();
    expect(papel("L")).toBeUndefined();
  });

  it("o título mesclado vai para a coluna que tem o número", () => {
    const cabecalho = (col: string) => cls.colunas.find((c) => c.coluna === col)?.cabecalho;

    // "Unit Price" está impresso em I e "Amount" em L, mas o número está em J e M.
    expect(cabecalho("J")).toBe("Unit Price");
    expect(cabecalho("M")).toBe("Amount");
    expect(cabecalho("D")).toBe("");
  });

  it("lê o cabeçalho do documento", () => {
    expect(cls.lista?.documento).toMatchObject({
      tipo: "COMERCIAL", numero: "PO900-2", dataIso: "2026-09-28", pedidos: ["PO100", "PO200"],
      bl: "BLTESTE123", container: "CONT1234567", moeda: "USD",
    });
    // O TOTAL impresso é lido para conferir com a soma.
    expect(cls.lista?.totalDocumento).toBe(1066.2);
    // Dois pedidos no S/C: linha sem pedido não herda nenhum.
    expect(cls.lista?.referenciaPadrao).toBeNull();
  });

  it("uma linha por item, com pedido, preço, valor, unidade e a origem", () => {
    expect(linhas).toHaveLength(5);
    expect(linhas[0]).toMatchObject({
      row: 19, column: "G", code: "TST01", ncm: "87141000", description: "PINÇA TRASEIRA DE TESTE",
      quantity: 200, quantityNeedsConfirmation: false, reference: "PO100",
      unitPrice: 1.06, amount: 212, currency: "USD", unit: "PCS",
    });
    expect(linhas[0]?.notes).toContain("Invoice PO900-2 de Sep 28,2026");
    expect(linhas[0]?.notes).toContain("contêiner CONT1234567");
    expect(linhas.map((l) => l.reference)).toEqual(["PO100", "PO100", "PO100", "PO200", "PO200"]);
    // A linha de total não entra.
    expect(linhas.some((l) => l.row === 25)).toBe(false);
    // PRS não é convertido: fica na observação para o usuário conferir.
    expect(linhas[1]?.notes).toContain("unidade na invoice: PRS");
    expect(linhas[1]?.quantity).toBe(80);
  });

  it("valor que não bate com quantidade × preço pede confirmação", () => {
    const errada = aba("INV", {
      ...Object.fromEntries([...COMERCIAL.grade].map(([n, l]) => [n, Object.fromEntries([...l].map(([c, v]) => [c, v.numerica ? Number(v.texto) : v.texto]))])),
      23: { A: 90292010, C: "PO200", D: "TST04", F: "PAINEL DE TESTE", G: 60, H: "PCS", I: "$", J: 1.8, L: "$", M: 999 },
    });
    const l = montarLinhas(errada, classificar(errada)).find((x) => x.row === 23);

    expect(l?.quantityNeedsConfirmation).toBe(true);
  });

  it("a lista de embalagem não é invoice e começa desmarcada", () => {
    expect(classificar(EMBALAGEM).lista).toBeUndefined();
    expect(ehListaDeEmbalagem(EMBALAGEM)).toBe(true);
    expect(ehListaDeEmbalagem(COMERCIAL)).toBe(false);
  });
});

describe("proforma e sales confirmation", () => {
  it("texto com quebra de linha e milhar com vírgula; o nº do documento é o pedido; a entrega é a previsão", () => {
    const cls = classificar(PROFORMA, "PI-SCX01080.xlsx");
    const linhas = montarLinhas(PROFORMA, cls);

    expect(cls.lista?.documento).toMatchObject({
      tipo: "PROFORMA", numero: "SCX01080", dataIso: "2026-10-26", entrega: "30.NOV.2026", entregaIso: "2026-11-30", moeda: "USD",
    });
    expect(cls.lista?.referenciaPadrao).toBe("SCX01080");
    expect(linhas).toHaveLength(2);
    expect(linhas[0]).toMatchObject({
      code: "X1002111465", description: "scooter de teste Roda 20", quantity: 243, unitPrice: 294, amount: 71442, reference: "SCX01080", unit: "PCS",
    });
  });

  it("sem $ nem USD a moeda fica desconhecida; o código sai do começo do modelo", () => {
    const cls = classificar(SEM_MOEDA, "A2026C701A-.xlsx");
    const linhas = montarLinhas(SEM_MOEDA, cls);

    expect(cls.lista?.documento.moeda).toBeNull();
    expect(cls.lista?.referenciaPadrao).toBe("A2026C701A");
    expect(linhas.map((l) => [l.code, l.quantity, l.unitPrice, l.currency, l.reference])).toEqual([
      ["TST-37", 670, 3, null, "A2026C701A"],
      ["TST-45", 670, 3.5, null, "A2026C701A"],
    ]);
    // Tamanho e cor viram observação.
    expect(linhas[0]?.notes).toContain("37 L");
    expect(linhas[0]?.notes).toContain("Black");
  });

  it("o nº padrão editado vale para as linhas sem pedido", () => {
    const cls = classificar(SEM_MOEDA, "proforma.xlsx");

    expect(cls.lista?.referenciaPadrao).toBeNull();
    if (cls.lista !== undefined) cls.lista.referenciaPadrao = "PO-777";
    expect(montarLinhas(SEM_MOEDA, cls).every((l) => l.reference === "PO-777")).toBe(true);
  });
});

describe("o controle de chegada continua matriz", () => {
  it("colunas de pedido não viram invoice (x × 1 = x não conta)", () => {
    const cls = classificar(CONTROLE);

    expect(cls.lista).toBeUndefined();
    expect(cls).toEqual(classificarAba(CONTROLE));
  });
});

describe("leitura do .xls (Excel 97–2003)", () => {
  const caminho = fileURLToPath(new URL("./__fixtures__/proforma-sintetica.xls", import.meta.url));
  const lida = lerXls(new Uint8Array(readFileSync(caminho)));

  it("abas, textos, números e o texto longo cortado entre blocos (CONTINUE)", () => {
    expect(lida.todas).toEqual([" Proforma Teste ", "Outra"]);

    const g = lida.abas[0]?.grade;

    expect(g?.get(2)?.get("A")?.texto).toBe("INVOICE Date:30/10/2026");
    expect(g?.get(7)?.get("A")?.texto).toBe("TST-45 Baú 45 L com base de metal");
    expect(g?.get(7)?.get("C")).toMatchObject({ texto: "770", numerica: true });
    expect(g?.get(8)?.get("D")?.texto).toBe("$ 16.60");
    expect(g?.get(11)?.get("A")?.texto).toBe("ç".repeat(9000));
    expect(g?.get(12)?.get("A")?.texto).toBe("depois do texto longo");
    expect(lida.abas[1]?.grade.get(1)?.get("A")?.texto).toBe("0.5");
    expect(lida.abas[1]?.grade.get(1)?.get("B")?.texto).toBe("-3");
  });

  it("a proforma .xls vira linhas de invoice", () => {
    const a = lida.abas[0];

    if (a === undefined) throw new Error("aba ausente");

    const linhas = montarLinhas(a, classificar(a, "Proforma Teste.xls"));

    expect(linhas.map((l) => [l.code, l.quantity, l.unitPrice, l.amount, l.currency, l.reference])).toEqual([
      ["TST-45", 770, 10.6, 8162, "USD", null],
      ["TST-57", 770, 16.6, 12782, "USD", null],
    ]);
  });

  it("recusa o que não é .xls e a versão anterior ao Excel 97", () => {
    expect(() => lerXls(new Uint8Array(600))).toThrow(XlsInvalido);
    // BOF de BIFF5 (0x0500).
    expect(() => lerBiff(new Uint8Array([0x09, 0x08, 0x04, 0x00, 0x00, 0x05, 0x05, 0x00]))).toThrow(/versão antiga/);
  });
});
