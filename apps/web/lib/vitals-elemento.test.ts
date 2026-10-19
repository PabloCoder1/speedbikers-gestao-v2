import { describe, expect, it } from "vitest";

import { descreverElemento, descricaoValida, formaDoElemento } from "./vitals-elemento";

describe("formaDoElemento", () => {
  it("leva a tag em minúscula e só as classes do design system, até duas", () => {
    expect(formaDoElemento("P", ["sb-meta-frase", "sb-extra", "sb-terceira"])).toBe("p.sb-meta-frase.sb-extra");
  });

  it("deixa de fora as classes que não são `sb-*`, que podem vir de fora do código", () => {
    expect(formaDoElemento("SPAN", ["texto-livre", "sb-status", "Sb-Maiuscula", "sb-com_sublinhado"])).toBe("span.sb-status");
  });

  it("sem classe do sistema, fica só a tag", () => {
    expect(formaDoElemento("H1", [])).toBe("h1");
  });
});

describe("descreverElemento", () => {
  it("põe a seção em que o elemento mora, com a posição dela", () => {
    expect(descreverElemento("p.sb-meta-frase", { forma: "section.sb-panel", posicao: 2 })).toBe(
      "p.sb-meta-frase < section.sb-panel#2",
    );
  });

  it("sem posição (a seção não está no conteúdo), só a forma da seção", () => {
    expect(descreverElemento("p", { forma: "section.sb-attention", posicao: 0 })).toBe("p < section.sb-attention");
  });

  it("sem seção, só o elemento", () => {
    expect(descreverElemento("h1.sb-page-title", null)).toBe("h1.sb-page-title");
  });
});

describe("descricaoValida", () => {
  it.each(["p", "h1.sb-page-title", "p.sb-meta-frase < section.sb-panel#2", "span < section.sb-attention", "img.sb-logo"])(
    "aceita a forma descrita: %s",
    (valor) => {
      expect(descricaoValida(valor)).toBe(true);
    },
  );

  it.each([
    ["texto da tela", "Bom dia, João"],
    ["rótulo de região", 'p @"Loja Centro"'],
    ["número solto", "p.sb-meta-frase 1234"],
    ["classe fora do sistema", "p.minha-classe"],
    ["vazio", ""],
    ["longo demais", `p.${"sb-x".repeat(40)}`],
  ])("recusa o que não é a forma (%s)", (_, valor) => {
    expect(descricaoValida(valor)).toBe(false);
  });

  it.each([null, undefined, 42, { el: "p" }])("recusa o que não é texto: %s", (valor) => {
    expect(descricaoValida(valor)).toBe(false);
  });
});
