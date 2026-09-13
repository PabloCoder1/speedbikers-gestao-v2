import { describe, expect, it } from "vitest";

import { redactSecretText } from "./sensitive.js";

/**
 * As regras de texto que o logger e a tela passaram a compartilhar (D-330).
 *
 * Os valores abaixo são FIXTURE — nenhum é credencial real. O que cada caso
 * fixa é uma família de regra, e o último fixa o que NÃO pode ser comido: a
 * mensagem benigna tem de continuar dizendo o que aconteceu.
 */
describe("redactSecretText", () => {
  it("troca o token do Mercado Livre sem rótulo", () => {
    const texto = redactSecretText("falhou com APP_USR-1234567890-token-de-teste no meio");

    expect(texto).not.toContain("APP_USR-1234567890");
    expect(texto).toContain("[REDACTED]");
  });

  it("troca o JWT depois de Authorization: Bearer", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0ZSJ9.assinaturadeteste123";
    const texto = redactSecretText(`Authorization: Bearer ${jwt}`);

    expect(texto).not.toContain(jwt);
    expect(texto).not.toContain("eyJhbGciOi");
  });

  it("troca o valor rotulado em JSON", () => {
    const texto = redactSecretText('{"access_token":"APP_USR-99999999999-fixture"}');

    expect(texto).not.toContain("99999999999");
  });

  it("troca a senha embutida num DSN, e mantém o host", () => {
    const texto = redactSecretText("postgres://usuario:senha-de-teste@db.exemplo.test:5432/postgres");

    expect(texto).not.toContain("senha-de-teste");
    expect(texto).toContain("db.exemplo.test");
  });

  it("troca a chave da Anthropic e o refresh do ML", () => {
    const texto = redactSecretText("chave sk-ant-fixture-123456 e refresh TG-abcdef1234567890");

    expect(texto).not.toContain("sk-ant-fixture");
    expect(texto).not.toContain("TG-abcdef");
  });

  it("aceita outro marcador — é assim que a tela escreve [oculto]", () => {
    expect(redactSecretText("token=APP_USR-1234567890-x", "[oculto]")).toBe("token=[oculto]");
  });

  it("não come texto benigno: o rótulo sem valor que pareça segredo fica", () => {
    expect(redactSecretText("troca de token: invalid_client")).toBe("troca de token: invalid_client");
    expect(redactSecretText("conta sem vínculo, 3 anúncios")).toBe("conta sem vínculo, 3 anúncios");
  });
});
