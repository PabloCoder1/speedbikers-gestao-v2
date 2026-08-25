import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseEnv } from "./env.js";

const OBRIGATORIAS = {
  GCP_PROJECT_ID: "speedbikers-gestao-v3",
  GCP_REGION: "southamerica-east1",
  WORKER_URL: "https://worker-rrquw5upla-rj.a.run.app",
  TASKS_INVOKER_SERVICE_ACCOUNT: "v3-tasks-invoker@speedbikers-gestao-v3.iam.gserviceaccount.com",
  API_URL: "https://api-rrquw5upla-rj.a.run.app",
  SCHEDULER_INVOKER_SERVICE_ACCOUNT:
    "v3-scheduler-invoker@speedbikers-gestao-v3.iam.gserviceaccount.com",
  SUPABASE_URL: "https://nmgccyqquwxecqffsidr.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_chave_de_teste_longa_o_bastante",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_chave_de_teste_longa_o_bastante",
  ERP_IMPORTS_BUCKET: "speedbikers-gestao-v3-erp-imports",
  MERCADO_LIVRE_CLIENT_ID: "APP_ID_123",
  MERCADO_LIVRE_CLIENT_SECRET: "segredo-de-teste",
  MERCADO_LIVRE_REDIRECT_URI: "https://api-rrquw5upla-rj.a.run.app/oauth/mercado-livre/callback",
  ML_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
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

  it("recusa boot sem as variáveis do Cloud Tasks", () => {
    // Sem estas, a api sobe e só falha ao tentar enfileirar — em produção,
    // no meio de um webhook. Morrer no start é o comportamento correto.
    expect(parseEnv({}).ok).toBe(false);
  });

  it("recusa WORKER_URL que não é URL", () => {
    expect(parseEnv({ ...OBRIGATORIAS, WORKER_URL: "worker" }).ok).toBe(false);
  });

  it("recusa service account que não é e-mail", () => {
    expect(parseEnv({ ...OBRIGATORIAS, TASKS_INVOKER_SERVICE_ACCOUNT: "v3-tasks" }).ok).toBe(
      false,
    );
  });

  it("recusa ML_TOKEN_ENCRYPTION_KEY com tamanho errado — morre no start, não no primeiro uso", () => {
    const result = parseEnv({ ...OBRIGATORIAS, ML_TOKEN_ENCRYPTION_KEY: "chave-curta-demais" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join()).toContain("ML_TOKEN_ENCRYPTION_KEY");
  });

  it("recusa MERCADO_LIVRE_REDIRECT_URI que não é URL", () => {
    expect(parseEnv({ ...OBRIGATORIAS, MERCADO_LIVRE_REDIRECT_URI: "callback" }).ok).toBe(false);
  });
});
