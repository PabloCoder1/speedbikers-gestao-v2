import { describe, expect, it } from "vitest";

import { applyTemplate } from "./apply-template.js";

describe("applyTemplate (D-111)", () => {
  it("campo vazio: o template vira o texto", () => {
    expect(applyTemplate("", "Olá! Obrigado pelo contato.", 2000)).toEqual({
      text: "Olá! Obrigado pelo contato.",
      applied: true,
    });
  });

  it("campo com rascunho: acrescenta depois de linha em branco, nunca apaga", () => {
    const result = applyTemplate("Já verifiquei o pedido.", "Qualquer dúvida, estamos à disposição.", 2000);

    expect(result.text).toBe("Já verifiquei o pedido.\n\nQualquer dúvida, estamos à disposição.");
  });

  it("espaço solto no fim do rascunho não vira linha em branco tripla", () => {
    expect(applyTemplate("Oi.\n\n", "Tchau.", 2000).text).toBe("Oi.\n\nTchau.");
  });

  it("estourou o teto: NÃO insere — truncar mandaria frase cortada ao cliente", () => {
    const rascunho = "a".repeat(1990);
    const result = applyTemplate(rascunho, "template maior que a sobra", 2000);

    expect(result.applied).toBe(false);
    expect(result.text).toBe(rascunho);
  });
});
