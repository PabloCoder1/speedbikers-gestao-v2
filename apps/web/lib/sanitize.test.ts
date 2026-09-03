import { SENSITIVE_KEY_NAMES } from "@sb/observability";
import { describe, expect, it } from "vitest";

import { sanitizeErrorText } from "./sanitize.js";

/**
 * Os casos vêm da revisão adversarial de D-231, que executou o regex antigo e
 * mostrou o JWT saindo inteiro em `Authorization: Bearer …`. Cada caso abaixo
 * afirma que o segredo INTEIRO e qualquer sufixo dele sumiram — não basta
 * mascarar o começo.
 */
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("sanitizeErrorText", () => {
  it("cabeçalho HTTP padrão: `Authorization: Bearer <jwt>` não deixa o token passar", () => {
    const texto = sanitizeErrorText(`Mercado Livre respondeu 401. Authorization: Bearer ${JWT}`);

    expect(texto).not.toContain(JWT);
    expect(texto).not.toContain("SflKxwRJ");
    expect(texto).toContain("[oculto]");
  });

  it("JSON com aspas: `\"authorization\":\"Bearer …\"` e `\"access_token\":\"…\"`", () => {
    const texto = sanitizeErrorText(
      `headers {"authorization":"Bearer APP_USR-1234567890-090312-abcdef0123456789"} body {"access_token":"APP_USR-9999999999-090312-ffffffffffffffff","refresh_token":"TG-68b9c0d1e2f3a4b5c6d7e8f9-123456789"}`,
    );

    expect(texto).not.toContain("APP_USR-1234567890");
    expect(texto).not.toContain("APP_USR-9999999999");
    expect(texto).not.toContain("TG-68b9c0d1");
  });

  it("token SEM rótulo — a forma real do Mercado Livre, JWT solto, chave da Anthropic", () => {
    const texto = sanitizeErrorText(
      `ML 401 invalid token APP_USR-1234567890-090312-abcdef0123456789-123456789; refresh failed: TG-68b9c0d1e2f3a4b5c6d7e8f9-123456789 invalid_grant; ${JWT}; sk-ant-api03-abcdefghijklmnop`,
    );

    expect(texto).not.toContain("APP_USR-1234567890");
    expect(texto).not.toContain("TG-68b9c0d1");
    expect(texto).not.toContain("eyJhbGci");
    expect(texto).not.toContain("sk-ant-api03-abcdefghijklmnop");
    // O que não é segredo sobrevive: é isto que faz o texto continuar útil.
    expect(texto).toContain("invalid_grant");
    expect(texto).toContain("ML 401 invalid token");
  });

  it("senha embutida em DSN e valor com `!`/`%`", () => {
    expect(sanitizeErrorText("db: postgres://postgres:Sup3rS3cretPwd@db.abc.supabase.co:5432/postgres")).not.toContain(
      "Sup3rS3cretPwd",
    );
    expect(sanitizeErrorText("client_secret=abc12!def456ghi789 falhou")).not.toContain("abc12!def456ghi789");
    expect(sanitizeErrorText('{"access_token":"APP%5FUSR-1234567890-abcdef"}')).not.toContain("1234567890-abcdef");
  });

  it("toda chave que o logger de @sb/observability redige também é ocultada aqui — uma lista, dois consumidores", () => {
    for (const nome of SENSITIVE_KEY_NAMES) {
      // O nome pode ser um padrão (ex.: `api[-_]?key`); um exemplar concreto basta.
      const exemplar = nome.replace("[-_]?", "_");
      const texto = sanitizeErrorText(`falha: ${exemplar}=VALORSECRETO123456 ao chamar`);

      expect(texto, nome).not.toContain("VALORSECRETO123456");
    }
  });

  it("a mensagem real que `ml-token.ts` grava hoje sobrevive intacta — o filtro não come texto benigno", () => {
    const original = "Mercado Livre recusou a troca de token: invalid_client.";

    expect(sanitizeErrorText(original)).toBe(original);
    expect(sanitizeErrorText("planilha sem a coluna sku")).toBe("planilha sem a coluna sku");
    // Palavras da lista usadas como PALAVRAS, não como rótulo de segredo: a
    // primeira versão do filtro comia as três.
    expect(sanitizeErrorText("chave no Secret Manager")).toBe("chave no Secret Manager");
    expect(sanitizeErrorText("senha incorreta")).toBe("senha incorreta");
    expect(sanitizeErrorText("erro de authorization: forbidden")).toBe("erro de authorization: forbidden");
  });

  it("query string de URL some; nulo e vazio continuam nulos; texto longo é cortado com reticências", () => {
    expect(sanitizeErrorText("GET https://api.mercadolibre.com/users/me?access_token=APP_USR-123456789012")).not.toContain(
      "access_token=",
    );
    expect(sanitizeErrorText(null)).toBeNull();
    expect(sanitizeErrorText("   ")).toBeNull();

    const longo = sanitizeErrorText("x".repeat(500), 50);

    expect(longo?.length).toBe(50);
    expect(longo?.endsWith("…")).toBe(true);
  });
});
