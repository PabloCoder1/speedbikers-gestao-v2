import { describe, expect, it } from "vitest";

import {
  APERTADO_ACIMA_DE,
  buildTemplateHref,
  CAIXA_LIMITE,
  estaApertado,
  NOME_LIMITE,
  nomeDaCopia,
  ocupacaoDaCaixa,
  resolveTemplateFilters,
} from "./template-filters";

const LIMPOS = { busca: null, ordem: "nome" } as const;

describe("resolveTemplateFilters", () => {
  it("aparas a busca e recusa ordem que não existe", () => {
    expect(resolveTemplateFilters({ busca: "  troca  ", ordem: "recentes" })).toEqual({
      busca: "troca",
      ordem: "recentes",
    });
    expect(resolveTemplateFilters({ busca: "   ", ordem: "; drop table" })).toEqual(LIMPOS);
  });

  it("corta a busca no teto do nome — a URL não abre janela para consulta gigante", () => {
    expect(resolveTemplateFilters({ busca: "a".repeat(500) }).busca).toHaveLength(NOME_LIMITE);
  });

  it("lê o primeiro valor quando o parâmetro vem repetido", () => {
    expect(resolveTemplateFilters({ ordem: ["maiores", "nome"] }).ordem).toBe("maiores");
  });
});

describe("buildTemplateHref", () => {
  it("mantém a busca ao trocar a ordem, e deixa o padrão fora da URL", () => {
    const atual = { busca: "garantia", ordem: "recentes" } as const;

    expect(buildTemplateHref(atual, { ordem: "maiores" })).toBe(
      "/atendimento/templates?busca=garantia&ordem=maiores",
    );
    expect(buildTemplateHref(atual, { ordem: "nome" })).toBe("/atendimento/templates?busca=garantia");
    expect(buildTemplateHref(LIMPOS)).toBe("/atendimento/templates");
  });
});

describe("orçamento da caixa de resposta", () => {
  it("mede a ocupação contra o teto real da caixa", () => {
    expect(ocupacaoDaCaixa("")).toBe(0);
    expect(ocupacaoDaCaixa("a".repeat(CAIXA_LIMITE / 2))).toBe(0.5);
    expect(ocupacaoDaCaixa("a".repeat(CAIXA_LIMITE))).toBe(1);
  });

  it("só chama de apertado o que passa do limiar, nunca o que encosta nele", () => {
    expect(estaApertado("a".repeat(APERTADO_ACIMA_DE))).toBe(false);
    expect(estaApertado("a".repeat(APERTADO_ACIMA_DE + 1))).toBe(true);
  });
});

describe("nomeDaCopia", () => {
  it("numera a partir da segunda cópia em vez de repetir um nome que o banco recusa", () => {
    expect(nomeDaCopia("Troca de produto", [])).toBe("Troca de produto (cópia)");
    expect(nomeDaCopia("Troca de produto", ["Troca de produto (cópia)"])).toBe(
      "Troca de produto (cópia 2)",
    );
    expect(
      nomeDaCopia("Troca de produto", ["troca de produto (CÓPIA)", "Troca de produto (cópia 2)"]),
    ).toBe("Troca de produto (cópia 3)");
  });

  it("corta o NOME para caber no CHECK de 80, nunca o sufixo", () => {
    const copia = nomeDaCopia("N".repeat(NOME_LIMITE), []);

    expect(copia).toHaveLength(NOME_LIMITE);
    expect(copia.endsWith(" (cópia)")).toBe(true);
  });
});
