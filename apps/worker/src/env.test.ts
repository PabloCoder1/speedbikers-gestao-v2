import { describe, expect, it } from "vitest";

import { parseEnv } from "./env.js";

const OBRIGATORIAS = {
  SUPABASE_URL: "https://nmgccyqquwxecqffsidr.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_chave_de_teste_longa_o_bastante",
  ERP_IMPORTS_BUCKET: "speedbikers-gestao-v3-erp-imports",
};

describe("parseEnv", () => {
  it("aplica os padrões quando nada é informado", () => {
    const result = parseEnv({ ...OBRIGATORIAS });

    expect(result.ok && result.env).toMatchObject({ NODE_ENV: "development", PORT: 8080 });
  });

  it("converte PORT de string para número, como o Cloud Run entrega", () => {
    const result = parseEnv({ ...OBRIGATORIAS, PORT: "8080" });

    expect(result.ok && result.env.PORT).toBe(8080);
  });

  it("rejeita PORT fora da faixa válida", () => {
    const result = parseEnv({ ...OBRIGATORIAS, PORT: "70000" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join()).toContain("PORT");
  });

  it("rejeita PORT que não é número", () => {
    expect(parseEnv({ ...OBRIGATORIAS, PORT: "oito mil" }).ok).toBe(false);
  });

  it("rejeita NODE_ENV desconhecido", () => {
    const result = parseEnv({ ...OBRIGATORIAS, NODE_ENV: "produção" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join()).toContain("NODE_ENV");
  });

  it("relata todos os problemas de uma vez, não um por execução", () => {
    const result = parseEnv({ ...OBRIGATORIAS, NODE_ENV: "staging", PORT: "-1" });

    expect(!result.ok && result.issues).toHaveLength(2);
  });

  it("aceita production", () => {
    expect(parseEnv({ ...OBRIGATORIAS, NODE_ENV: "production" }).ok).toBe(true);
  });

  it("recusa boot sem as credenciais do Supabase", () => {
    // Sem elas o worker sobe e só falha ao gravar — depois de já ter feito o
    // trabalho. Morrer no start é o comportamento correto.
    expect(parseEnv({}).ok).toBe(false);
  });

  it("recusa chave curta demais para ser uma service_role", () => {
    expect(parseEnv({ ...OBRIGATORIAS, SUPABASE_SERVICE_ROLE_KEY: "curta" }).ok).toBe(false);
  });
});
