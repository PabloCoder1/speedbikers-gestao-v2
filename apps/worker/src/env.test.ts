import { describe, expect, it } from "vitest";

import { parseEnv } from "./env.js";

describe("parseEnv", () => {
  it("aplica os padrões quando nada é informado", () => {
    const result = parseEnv({});

    expect(result).toEqual({ ok: true, env: { NODE_ENV: "development", PORT: 8080 } });
  });

  it("converte PORT de string para número, como o Cloud Run entrega", () => {
    const result = parseEnv({ PORT: "8080" });

    expect(result.ok && result.env.PORT).toBe(8080);
  });

  it("rejeita PORT fora da faixa válida", () => {
    const result = parseEnv({ PORT: "70000" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join()).toContain("PORT");
  });

  it("rejeita PORT que não é número", () => {
    expect(parseEnv({ PORT: "oito mil" }).ok).toBe(false);
  });

  it("rejeita NODE_ENV desconhecido", () => {
    const result = parseEnv({ NODE_ENV: "produção" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join()).toContain("NODE_ENV");
  });

  it("relata todos os problemas de uma vez, não um por execução", () => {
    const result = parseEnv({ NODE_ENV: "staging", PORT: "-1" });

    expect(!result.ok && result.issues).toHaveLength(2);
  });

  it("aceita production", () => {
    expect(parseEnv({ NODE_ENV: "production" }).ok).toBe(true);
  });
});
