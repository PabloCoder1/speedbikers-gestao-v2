import { describe, expect, it } from "vitest";

import { describeIntegrations, sanitizeErrorText } from "./integrations.js";
import type { IntegrationsInput } from "./integrations.js";

const NOW = new Date("2026-09-03T15:00:00.000Z");

function horasAtras(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}

/** Tudo saudável e observado — a base que cada teste distorce num ponto. */
function base(): IntegrationsInput {
  return {
    now: NOW,
    mlAccounts: [
      { label: "Loja 1", status: "CONNECTED", connected_at: horasAtras(48), last_error: null },
      { label: "Loja 2", status: "CONNECTED", connected_at: horasAtras(2), last_error: null },
    ],
    syncHealth: [
      {
        resource: "orders",
        channel: "reconciliation",
        last_run_at: horasAtras(0.5),
        last_success_at: horasAtras(0.5),
        failed_24h: 0,
        runs_24h: 24,
      },
      {
        resource: "visits",
        channel: "reconciliation",
        last_run_at: horasAtras(20),
        last_success_at: horasAtras(20),
        failed_24h: 0,
        runs_24h: 1,
      },
      // Backfill é finito: não entra no veredito de frescor (D-143).
      { resource: "orders", channel: "backfill", last_run_at: horasAtras(300), last_success_at: null, failed_24h: 0, runs_24h: 0 },
    ],
    jobs: [
      { job_type: "system.ping", job_status: "done", job_last_run_at: horasAtras(0.5), job_failures_24h: 0 },
      { job_type: "sync.webhook.received", job_status: "done", job_last_run_at: horasAtras(0.1), job_failures_24h: 3 },
      { job_type: "maintenance.check-ai-budget", job_status: "done", job_last_run_at: horasAtras(6), job_failures_24h: 0 },
    ],
    importBatches: [{ status: "APPLIED", created_at: horasAtras(24 * 14), last_error: null }],
    ai: { runs: 38, lastRunAt: horasAtras(3), monthCostUsd: 0 },
    api: { configured: true, health: { commit: "6baa641", startedAt: horasAtras(1) } },
    dbReachable: true,
  };
}

function card(input: IntegrationsInput, id: string) {
  const found = describeIntegrations(input).find((c) => c.id === id);

  if (found === undefined) throw new Error(`card ${id} não existe`);

  return found;
}

describe("sanitizeErrorText", () => {
  it("oculta o que parece segredo e corta query string de URL", () => {
    const texto = sanitizeErrorText(
      'Mercado Livre respondeu 401 para GET https://api.mercadolibre.com/users/me?access_token=APP_USR-123456 body {"access_token":"APP_USR-abcdef123456","refresh_token": "TG-99887766"}',
    );

    expect(texto).not.toContain("APP_USR-abcdef123456");
    expect(texto).not.toContain("TG-99887766");
    expect(texto).not.toContain("access_token=APP_USR-123456");
    expect(texto).toContain("[oculto]");
  });

  it("nulo e vazio continuam nulos; texto longo é cortado com reticências", () => {
    expect(sanitizeErrorText(null)).toBeNull();
    expect(sanitizeErrorText("   ")).toBeNull();

    const longo = sanitizeErrorText("x".repeat(500), 50);

    expect(longo?.length).toBe(50);
    expect(longo?.endsWith("…")).toBe(true);
  });
});

describe("describeIntegrations — a regra que vale para todas", () => {
  it("nesta versão NENHUMA configuração vira ok: não há coletor autenticado, e configuração existente não é atividade", () => {
    for (const c of describeIntegrations(base())) {
      expect(c.configuration.state).not.toBe("ok");
      expect(c.configuration.state).toBe("nao_verificavel");
    }
  });

  it("dimensão que não se aplica é null, não um estado inventado", () => {
    const cards = describeIntegrations(base());

    expect(cards.find((c) => c.id === "upseller")?.connection).toBeNull();
    expect(cards.find((c) => c.id === "webhook")?.sync).toBeNull();
    expect(cards.find((c) => c.id === "supabase")?.sync).toBeNull();
  });

  it("toda integração aponta para pelo menos uma tela dona", () => {
    for (const c of describeIntegrations(base())) {
      expect(c.links.length).toBeGreaterThan(0);
    }
  });
});

describe("Mercado Livre", () => {
  it("todas conectadas e reconciliação em dia: ok nas duas dimensões, configuração não verificável", () => {
    const ml = card(base(), "mercado_livre");

    expect(ml.connection?.state).toBe("ok");
    expect(ml.connection?.detail).toBe("2 conta(s) conectada(s)");
    expect(ml.sync?.state).toBe("ok");
    // 2 recursos de reconciliação (backfill fica fora), 0 falhas.
    expect(ml.sync?.detail).toBe("2 em dia, 0 atrasando, 0 atrasado(s), 0 nunca; 0 falha(s) em 24h");
    expect(ml.configuration.state).toBe("nao_verificavel");
  });

  it("uma conta em ERROR derruba a conexão para erro, com o motivo SANITIZADO", () => {
    const input = base();
    input.mlAccounts = [
      { label: "Loja 1", status: "CONNECTED", connected_at: horasAtras(48), last_error: null },
      {
        label: "GMR",
        status: "ERROR",
        connected_at: horasAtras(100),
        last_error: "Mercado Livre recusou a troca de token: invalid_client. refresh_token=TG-SEGREDO123456",
      },
    ];

    const ml = card(input, "mercado_livre");

    expect(ml.connection?.state).toBe("erro");
    expect(ml.connection?.detail).toContain("1 de 2 contas conectadas");
    expect(ml.connection?.detail).toContain("GMR");
    expect(ml.connection?.detail).toContain("invalid_client");
    expect(ml.connection?.detail).not.toContain("TG-SEGREDO123456");
  });

  it("nenhuma conta cadastrada é nao_configurado; leitura que falhou é nao_verificavel — nunca ok", () => {
    const vazio = base();
    vazio.mlAccounts = [];
    expect(card(vazio, "mercado_livre").connection?.state).toBe("nao_configurado");

    const falhou = base();
    falhou.mlAccounts = null;
    expect(card(falhou, "mercado_livre").connection?.state).toBe("nao_verificavel");
  });

  it("um recurso horário mudo há 13 h é erro na sincronização — o cenário de D-217, com o veredito de D-143", () => {
    const input = base();
    input.syncHealth = [
      {
        resource: "orders",
        channel: "reconciliation",
        last_run_at: horasAtras(13),
        last_success_at: horasAtras(13),
        failed_24h: 0,
        runs_24h: 0,
      },
    ];

    const ml = card(input, "mercado_livre");

    expect(ml.sync?.state).toBe("erro");
    expect(ml.sync?.detail).toContain("1 atrasado(s)");
  });
});

describe("Webhook", () => {
  it("recebido há minutos é ok, e as falhas de 24h aparecem no detalhe", () => {
    const w = card(base(), "webhook");

    expect(w.connection?.state).toBe("ok");
    expect(w.connection?.detail).toContain("3 falha(s) em 24h");
  });

  it("um dia inteiro sem webhook é atenção — o limiar de 24 h é medido (5.218 execuções/dia em 03/09/2026)", () => {
    const input = base();
    input.jobs = [{ job_type: "sync.webhook.received", job_status: "done", job_last_run_at: horasAtras(30), job_failures_24h: 0 }];

    const w = card(input, "webhook");

    expect(w.connection?.state).toBe("atencao");
    expect(w.connection?.detail).toContain("acima do limiar de 24 h");
  });

  it("sem registro nenhum é nao_verificavel, não erro nem ok", () => {
    const input = base();
    input.jobs = [];
    expect(card(input, "webhook").connection?.state).toBe("nao_verificavel");
  });
});

describe("UpSeller", () => {
  it("último lote APPLIED é ok e diz a idade; FAILED é erro com o motivo sanitizado; em andamento é atenção", () => {
    expect(card(base(), "upseller").sync).toMatchObject({ state: "ok", detail: "último lote aplicado há 14 dia(s)" });

    const falhou = base();
    falhou.importBatches = [{ status: "FAILED", created_at: horasAtras(2), last_error: "planilha sem a coluna sku; apikey=XYZ12345678" }];
    const u = card(falhou, "upseller");
    expect(u.sync?.state).toBe("erro");
    expect(u.sync?.detail).toContain("planilha sem a coluna sku");
    expect(u.sync?.detail).not.toContain("XYZ12345678");

    const andando = base();
    andando.importBatches = [{ status: "PARSING", created_at: horasAtras(1), last_error: null }];
    expect(card(andando, "upseller").sync?.state).toBe("atencao");
  });

  it("nunca importado é nao_configurado", () => {
    const input = base();
    input.importBatches = [];
    expect(card(input, "upseller").sync?.state).toBe("nao_configurado");
  });
});

describe("IA, Supabase e Google Cloud", () => {
  it("IA com execuções é ok (uso sob demanda não ganha selo de atraso) e a configuração cita a conferência do teto", () => {
    const i = card(base(), "ia");

    expect(i.sync?.state).toBe("ok");
    expect(i.sync?.detail).toBe("38 execução(ões); US$ 0.00 no mês");
    expect(i.configuration.detail).toContain("teto conferido há 6 h");
  });

  it("Supabase: a conexão é ok porque ESTA página leu o banco — observação, não presunção; e vira erro quando as leituras falharam", () => {
    expect(card(base(), "supabase").connection?.state).toBe("ok");

    const input = base();
    input.dbReachable = false;
    expect(card(input, "supabase").connection?.state).toBe("erro");
  });

  it("Google Cloud: API no ar e heartbeat em dia é ok; API muda é erro; sem URL é nao_verificavel, nunca 'fora do ar'", () => {
    expect(card(base(), "google_cloud").connection?.state).toBe("ok");

    const muda = base();
    muda.api = { configured: true, health: null };
    expect(card(muda, "google_cloud").connection?.state).toBe("erro");

    const semUrl = base();
    semUrl.api = { configured: false, health: null };
    const g = card(semUrl, "google_cloud");
    expect(g.connection?.state).toBe("nao_verificavel");
    expect(g.connection?.detail).toContain("sem NEXT_PUBLIC_API_URL");
  });

  it("heartbeat horário mudo há 5 h derruba o Google Cloud para erro mesmo com a API respondendo", () => {
    const input = base();
    input.jobs = [{ job_type: "system.ping", job_status: "done", job_last_run_at: horasAtras(5), job_failures_24h: 0 }];

    const g = card(input, "google_cloud");

    expect(g.connection?.state).toBe("erro");
    expect(g.connection?.detail).toContain("heartbeat há 5 h");
  });
});
