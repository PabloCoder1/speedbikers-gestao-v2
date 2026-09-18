import { describe, expect, it } from "vitest";

import { erroLegivel, limparTexto } from "./document-error";

// Os bytes vêm de `String.fromCharCode` e não de escape no texto: o arquivo de
// teste não pode ele mesmo carregar caractere de controle.
const R = String.fromCharCode(0xfffd);
const CONTROLE = String.fromCharCode(0x14, 0x02, 0x08);
const QUEBRA = String.fromCharCode(10);

// O `last_error` real do primeiro DANFE de produção (18/09/2026), encurtado:
// o leitor de XML abriu o PDF e citou os bytes onde parou. `R` é o U+FFFD, o
// caractere de substituição de byte que não é UTF-8.
const ERRO_DO_PDF = `readTagExp returned undefined at position 72929. Context: "${R}${CONTROLE}${R}${R}G${R}F${CONTROLE}Q${R}${R}${R}${R}G"`;

/** Algum caractere de controle ou U+FFFD sobrou? */
function temLixo(texto: string): boolean {
  for (let i = 0; i < texto.length; i += 1) {
    const codigo = texto.charCodeAt(i);

    if (codigo < 0x20 || codigo === 0xfffd) return true;
  }

  return false;
}

describe("erroLegivel", () => {
  it("PDF lido como XML vira instrução, e o detalhe sai sem bytes de controle", () => {
    const erro = erroLegivel(ERRO_DO_PDF, { leu: false });

    expect(erro.resumo).toContain("envie de novo");
    expect(erro.detalhe).toContain("readTagExp returned undefined at position 72929");
    expect(temLixo(erro.detalhe ?? "")).toBe(false);
  });

  it("frase curta do nosso leitor é o próprio resumo", () => {
    expect(erroLegivel("PDF sem texto: parece uma imagem digitalizada", { leu: false })).toEqual({
      resumo: "PDF sem texto: parece uma imagem digitalizada",
      detalhe: null,
    });
  });

  it("falha longa depois da leitura fala da aplicação, não da leitura", () => {
    const erro = erroLegivel(`violação de restrição ${"x".repeat(400)}`, { leu: true });

    expect(erro.resumo).toContain("aplicação");
    expect(erro.detalhe?.endsWith("…")).toBe(true);
    expect(erro.detalhe?.length).toBeLessThanOrEqual(281);
  });

  it("assinatura de XML depois da leitura não vira conselho de reenviar", () => {
    expect(erroLegivel(ERRO_DO_PDF, { leu: true }).resumo).not.toContain("envie de novo");
  });
});

describe("limparTexto", () => {
  it("troca controle e U+FFFD por espaço e junta os espaços", () => {
    const sujo = `a${String.fromCharCode(0, 0x14)}b${R}${R}c${QUEBRA}${QUEBRA} d`;

    expect(limparTexto(sujo)).toBe("a b c d");
  });
});
