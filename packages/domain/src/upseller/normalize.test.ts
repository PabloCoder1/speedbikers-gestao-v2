import { describe, expect, it } from "vitest";

import {
  cell,
  normalizeUnit,
  parseCategory,
  parseDecimal,
  parseFlag,
  parseOriginCode,
  skuKey,
} from "./normalize.js";

describe("cell", () => {
  it.each([null, undefined, "", "   ", "-"])("trata %s como vazio", (raw) => {
    expect(cell(raw)).toBeNull();
  });

  it("apara espaços", () => {
    expect(cell("  FA100  ")).toBe("FA100");
  });

  it("aceita número vindo direto da planilha", () => {
    expect(cell(174.9)).toBe("174.9");
  });

  it("objeto inesperado vira null, não '[object Object]'", () => {
    // Texto que parece dado válido e não é seria pior que ausência de dado.
    expect(cell({ foo: "bar" })).toBeNull();
  });

  it("data de planilha vira ISO, não string de locale", () => {
    expect(cell(new Date("2026-08-19T16:43:56Z"))).toBe("2026-08-19T16:43:56.000Z");
  });
});

describe("skuKey", () => {
  it("normaliza caixa e espaço", () => {
    expect(skuKey(" bau98 ")).toBe("BAU98");
  });

  it("dois SKUs que só diferem na caixa colidem — é o comportamento desejado", () => {
    expect(skuKey("bau98")).toBe(skuKey("BAU98"));
  });
});

describe("normalizeUnit", () => {
  it.each([
    ["UN", "UN"],
    ["UNID", "UN"],
    ["PC", "UN"],
    ["PECAS", "UN"],
    ["PAR", "PAR"],
    ["PA", "PAR"],
    ["KIT", "KIT"],
  ])("%s vira %s", (raw, expected) => {
    expect(normalizeUnit(raw)).toBe(expected);
  });

  it("unidade desconhecida sobe em caixa alta, sem inventar equivalência", () => {
    expect(normalizeUnit("caixa")).toBe("CAIXA");
  });

  it("vazio continua vazio", () => {
    expect(normalizeUnit("-")).toBeNull();
  });
});

describe("parseCategory", () => {
  it("categoria simples vira marca", () => {
    expect(parseCategory("NAVETEC")).toEqual({
      brand: "NAVETEC",
      isDiscontinued: false,
      categoryRaw: "NAVETEC",
    });
  });

  it("unifica duplicata por caixa", () => {
    expect(parseCategory("Plasmoto").brand).toBe(parseCategory("PLASMOTO").brand);
  });

  it("hierarquia por seta: a marca é a parte antes do separador", () => {
    expect(parseCategory("MANETE→XRE/BROS/TORNADO").brand).toBe("MANETE");
  });

  it("ESTOQUE INATIVO não é marca — é produto em encerramento", () => {
    // Tratar como lixo perderia informação de negócio real.
    expect(parseCategory("ESTOQUE INATIVO")).toEqual({
      brand: null,
      isDiscontinued: true,
      categoryRaw: "ESTOQUE INATIVO",
    });
  });

  it("categoria só de dígitos é ruído, não marca", () => {
    expect(parseCategory("999").brand).toBeNull();
  });

  it("preserva o valor original mesmo quando não vira marca", () => {
    expect(parseCategory("999").categoryRaw).toBe("999");
  });

  it("vazio não marca como descontinuado", () => {
    expect(parseCategory(null)).toEqual({
      brand: null,
      isDiscontinued: false,
      categoryRaw: null,
    });
  });
});

describe("parseOriginCode", () => {
  it.each([
    ["0", 0],
    ["1", 1],
    ["2", 2],
  ])("aceita o código fiscal %s", (raw, expected) => {
    expect(parseOriginCode(raw)).toBe(expected);
  });

  it("recusa código fora da tabela fiscal", () => {
    expect(parseOriginCode("9")).toBeNull();
  });

  it("recusa texto", () => {
    expect(parseOriginCode("nacional")).toBeNull();
  });
});

describe("parseDecimal", () => {
  it("aceita número direto da planilha", () => {
    expect(parseDecimal(174.9)).toBe(174.9);
  });

  it("aceita ponto decimal", () => {
    expect(parseDecimal("174.90")).toBe(174.9);
  });

  it("aceita vírgula decimal — a exportação varia com a configuração regional", () => {
    expect(parseDecimal("174,90")).toBe(174.9);
  });

  it("aceita separador de milhar com vírgula decimal", () => {
    expect(parseDecimal("1.174,90")).toBe(1174.9);
  });

  it("vazio vira null, não zero", () => {
    // Zero e "sem informação" são coisas diferentes: um custo ausente não é
    // um custo de R$ 0,00.
    expect(parseDecimal("-")).toBeNull();
  });
});

describe("parseFlag", () => {
  it("Y é verdadeiro", () => {
    expect(parseFlag("Y", false)).toBe(true);
  });

  it("N é falso", () => {
    expect(parseFlag("N", true)).toBe(false);
  });

  it("vazio usa o padrão informado", () => {
    expect(parseFlag("-", true)).toBe(true);
  });
});
