import { describe, expect, it } from "vitest";

import {
  custoInformado,
  diasEntre,
  hojeSaoPaulo,
  lerListaColada,
  numeroPositivo,
  prazoPorExtenso,
  resumirRascunho,
  somarDias,
  subtotal,
  type ItemRascunho,
} from "./rascunho";

const item = (parcial: Partial<ItemRascunho> & { key: string }): ItemRascunho => ({
  skuId: null,
  skuSnapshot: "",
  quantityOrdered: "",
  unitCost: "",
  ...parcial,
});

describe("números digitados", () => {
  it("quantidade precisa ser positiva; custo aceita zero", () => {
    expect(numeroPositivo("")).toBeNull();
    expect(numeroPositivo("0")).toBeNull();
    expect(numeroPositivo("-2")).toBeNull();
    expect(numeroPositivo("2.5")).toBe(2.5);
    expect(custoInformado("0")).toBe(0);
    expect(custoInformado("")).toBeNull();
    expect(custoInformado("-1")).toBeNull();
  });

  it("subtotal arredonda em centavos e some sem custo", () => {
    expect(subtotal({ quantityOrdered: "3", unitCost: "10.335" })).toBe(31.01);
    expect(subtotal({ quantityOrdered: "3", unitCost: "" })).toBeNull();
  });
});

describe("resumirRascunho", () => {
  it("a mesma conta do pedido salvo: 5 × 10,50 = 52,50", () => {
    const r = resumirRascunho([item({ key: "a", skuSnapshot: "PEDIDO-E2E-001", quantityOrdered: "5", unitCost: "10.5" })]);

    expect(r).toMatchObject({ itens: 1, unidades: 5, valor: 52.5, semCusto: 0, incompletas: 0 });
  });

  it("item sem custo fica fora da soma e é contado; linha vazia não conta nada", () => {
    const r = resumirRascunho([
      item({ key: "a", skuSnapshot: "A", quantityOrdered: "2", unitCost: "10" }),
      item({ key: "b", skuSnapshot: "B", quantityOrdered: "4" }),
      item({ key: "c" }),
    ]);

    expect(r).toMatchObject({ itens: 2, unidades: 6, valor: 20, semCusto: 1, incompletas: 0 });
  });

  it("nenhum item com custo: valor DESCONHECIDO, nunca R$ 0,00 (D-254)", () => {
    expect(resumirRascunho([item({ key: "a", skuSnapshot: "A", quantityOrdered: "2" })]).valor).toBeNull();
    // Sem item nenhum, zero é sabido.
    expect(resumirRascunho([item({ key: "a" })]).valor).toBe(0);
  });

  it("linha pela metade é incompleta, não item", () => {
    const r = resumirRascunho([item({ key: "a", skuSnapshot: "A" }), item({ key: "b", quantityOrdered: "3" })]);

    expect(r).toMatchObject({ itens: 0, incompletas: 2 });
  });

  it("o mesmo SKU catalogado em duas linhas é apontado nas duas", () => {
    const r = resumirRascunho([
      item({ key: "a", skuId: "s1", skuSnapshot: "A", quantityOrdered: "1" }),
      item({ key: "b", skuId: "s1", skuSnapshot: "A", quantityOrdered: "2" }),
      item({ key: "c", skuId: "s2", skuSnapshot: "B", quantityOrdered: "2" }),
    ]);

    expect([...r.duplicadas].sort()).toEqual(["a", "b"]);
  });
});

describe("lerListaColada", () => {
  it("aceita planilha (tab), ponto e vírgula e espaços, com custo brasileiro", () => {
    expect(lerListaColada("ABC-1\t10\t12,50\nXYZ-2;3;1.234,56\nQWE-3 7")).toEqual([
      { sku: "ABC-1", quantidade: 10, custo: 12.5 },
      { sku: "XYZ-2", quantidade: 3, custo: 1234.56 },
      { sku: "QWE-3", quantidade: 7, custo: null },
    ]);
  });

  it("ignora cabeçalho e linha vazia; SKU repetido soma a quantidade", () => {
    expect(lerListaColada("SKU\tQuantidade\tCusto\n\nabc-1\t2\nABC-1\t3\t9")).toEqual([
      { sku: "abc-1", quantidade: 5, custo: 9 },
    ]);
  });

  it("só o SKU é obrigatório, e há teto de linhas", () => {
    expect(lerListaColada("SOZINHO")).toEqual([{ sku: "SOZINHO", quantidade: null, custo: null }]);
    expect(lerListaColada(Array.from({ length: 150 }, (_, i) => `S${String(i)} 1`).join("\n"))).toHaveLength(100);
  });
});

describe("datas de negócio", () => {
  it("hoje em São Paulo, não em UTC", () => {
    // 01:30 UTC de 18/09 ainda é 17/09 em São Paulo.
    expect(hojeSaoPaulo(new Date("2026-09-18T01:30:00Z"))).toBe("2026-09-17");
  });

  it("soma dias atravessando mês e ano", () => {
    expect(somarDias("2026-09-17", 15)).toBe("2026-10-02");
    expect(somarDias("2026-12-25", 10)).toBe("2027-01-04");
  });

  it("prazo por extenso", () => {
    expect(diasEntre("2026-09-17", "2026-10-02")).toBe(15);
    expect(prazoPorExtenso(0)).toBe("hoje");
    expect(prazoPorExtenso(1)).toBe("amanhã");
    expect(prazoPorExtenso(15)).toBe("em 15 dias");
    expect(prazoPorExtenso(-3)).toBe("há 3 dias");
  });
});
