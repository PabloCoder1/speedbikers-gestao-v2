import { describe, expect, it } from "vitest";

import {
  MAX_QUANTIDADE,
  chaveDoSku,
  lerListaDeSkus,
  mensagemDaApi,
  particionarEmLotes,
  quantidadeValida,
  respostaDeEdicaoDeItemValida,
  respostaDeSaidaValida,
  somarQuantidadeNoLimite,
} from "./saida-manual";

describe("chaveDoSku", () => {
  it("normaliza como a coluna gerada sku_key", () => {
    expect(chaveDoSku("  pn-700x23c ")).toBe("PN-700X23C");
  });
});

describe("quantidadeValida", () => {
  it("aceita só inteiro positivo dentro do limite", () => {
    expect(quantidadeValida("3")).toBe(3);
    expect(quantidadeValida(" 12 ")).toBe(12);
    expect(quantidadeValida("0")).toBeNull();
    expect(quantidadeValida("1.5")).toBeNull();
    expect(quantidadeValida("-2")).toBeNull();
    expect(quantidadeValida("")).toBeNull();
    expect(quantidadeValida("1000001")).toBeNull();
  });
});

describe("lerListaDeSkus", () => {
  it("lê planilha copiada, CSV e espaço; sem quantidade vale 1", () => {
    const { linhas, invalidas } = lerListaDeSkus("PN-1\t4\nPN-2;2\nPN-3, 7\nPN-4 9\nPN-5\n");

    expect(invalidas).toEqual([]);
    expect(linhas).toEqual([
      { codigo: "PN-1", quantidade: 4 },
      { codigo: "PN-2", quantidade: 2 },
      { codigo: "PN-3", quantidade: 7 },
      { codigo: "PN-4", quantidade: 9 },
      { codigo: "PN-5", quantidade: 1 },
    ]);
  });

  it("soma o mesmo SKU escrito de jeitos diferentes", () => {
    expect(lerListaDeSkus("pn-1;2\nPN-1 ;3").linhas).toEqual([{ codigo: "pn-1", quantidade: 5 }]);
  });

  it("pula o cabeçalho e devolve o número das linhas que não se leem", () => {
    const { linhas, invalidas } = lerListaDeSkus("SKU;Quantidade\nPN-1;2\nPN-2;zero\nPN-3;1;extra\n\nPN-4;0");

    expect(linhas).toEqual([{ codigo: "PN-1", quantidade: 2 }]);
    expect(invalidas).toEqual([3, 4, 6]);
  });
});

describe("mensagemDaApi", () => {
  it("tira a mensagem do corpo de erro da api e ignora o resto", () => {
    expect(mensagemDaApi({ error: { code: "rejected", message: "um ou mais SKUs não existem" } })).toBe(
      "um ou mais SKUs não existem",
    );
    expect(mensagemDaApi({ error: { code: "unauthorized" } })).toBeUndefined();
    expect(mensagemDaApi(null)).toBeUndefined();
    expect(mensagemDaApi("texto")).toBeUndefined();
  });
});

describe("guardas da saída manual e edição de item (D-771)", () => {
  it("particionarEmLotes fatia listas longas para consultas .in() sem estourar URL", () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${String(i)}`);
    const lotes = particionarEmLotes(ids, 100);

    expect(lotes.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(particionarEmLotes([])).toEqual([]);
  });

  it("somarQuantidadeNoLimite não ultrapassa MAX_QUANTIDADE", () => {
    expect(somarQuantidadeNoLimite(5, 3)).toBe(8);
    expect(somarQuantidadeNoLimite(MAX_QUANTIDADE - 2, 10)).toBe(MAX_QUANTIDADE);
  });

  it("valida corpo JSON de sucesso da saída manual e da edição de item", () => {
    expect(respostaDeSaidaValida({ requestId: "req-1", itens: 1, unidades: 2 }, "req-1")).toBe(true);
    expect(respostaDeSaidaValida({ requestId: "outro" }, "req-1")).toBe(false);
    expect(respostaDeSaidaValida(null, "req-1")).toBe(false);

    expect(respostaDeEdicaoDeItemValida({ totalItems: 3, resolvedItems: 2 })).toBe(true);
    expect(respostaDeEdicaoDeItemValida(null)).toBe(false);
    expect(respostaDeEdicaoDeItemValida({})).toBe(false);
  });
});
