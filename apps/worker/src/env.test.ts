import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseEnv } from "./env.js";

const OBRIGATORIAS = {
  SUPABASE_URL: "https://nmgccyqquwxecqffsidr.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_chave_de_teste_longa_o_bastante",
  ERP_IMPORTS_BUCKET: "speedbikers-gestao-v3-erp-imports",
  MERCADO_LIVRE_CLIENT_ID: "APP_ID_123",
  MERCADO_LIVRE_CLIENT_SECRET: "segredo-de-teste",
  ML_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  GCP_PROJECT_ID: "speedbikers-gestao-v3",
  GCP_REGION: "southamerica-east1",
  WORKER_URL: "https://worker-rrquw5upla-rj.a.run.app",
  TASKS_INVOKER_SERVICE_ACCOUNT: "v3-tasks-invoker@speedbikers-gestao-v3.iam.gserviceaccount.com",
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

  it("recusa ML_TOKEN_ENCRYPTION_KEY com tamanho errado — morre no start, não no primeiro refresh", () => {
    const result = parseEnv({ ...OBRIGATORIAS, ML_TOKEN_ENCRYPTION_KEY: "chave-curta-demais" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join()).toContain("ML_TOKEN_ENCRYPTION_KEY");
  });

  it("recusa WORKER_URL que não é URL — o worker se reenfileira para essa URL", () => {
    expect(parseEnv({ ...OBRIGATORIAS, WORKER_URL: "worker" }).ok).toBe(false);
  });

  it("recusa TASKS_INVOKER_SERVICE_ACCOUNT que não é e-mail", () => {
    expect(parseEnv({ ...OBRIGATORIAS, TASKS_INVOKER_SERVICE_ACCOUNT: "v3-tasks" }).ok).toBe(false);
  });

  it("AI_MONTHLY_BUDGET_USD ausente cai no default 18 — esquecer a variável no deploy não derruba o boot (D-100)", () => {
    const result = parseEnv({ ...OBRIGATORIAS });

    expect(result.ok && result.env.AI_MONTHLY_BUDGET_USD).toBe(18);
  });

  it("AI_MONTHLY_BUDGET_USD vem como string do --set-env-vars e é convertida", () => {
    const result = parseEnv({ ...OBRIGATORIAS, AI_MONTHLY_BUDGET_USD: "25.5" });

    expect(result.ok && result.env.AI_MONTHLY_BUDGET_USD).toBe(25.5);
  });

  it("recusa AI_MONTHLY_BUDGET_USD zero ou negativo — teto inválido não pode virar silêncio", () => {
    expect(parseEnv({ ...OBRIGATORIAS, AI_MONTHLY_BUDGET_USD: "0" }).ok).toBe(false);
    expect(parseEnv({ ...OBRIGATORIAS, AI_MONTHLY_BUDGET_USD: "-5" }).ok).toBe(false);
  });
});
