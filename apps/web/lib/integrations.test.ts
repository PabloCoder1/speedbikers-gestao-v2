import { describe, expect, it } from "vitest";

import { describeIntegrations, fromVerdict } from "./integrations.js";
import type { IntegrationsInput, IntegrationState } from "./integrations.js";

const NOW = new Date("2026-09-03T15:00:00.000Z");

function horasAtras(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}

const CONTA_1 = "aaaaaaaa-0000-4000-8000-000000000001";
const CONTA_2 = "aaaaaaaa-0000-4000-8000-000000000002";

function reconciliacao(
  contaId: string,
  resource: string,
  horasDesdeSucesso: number,
  extra: Partial<IntegrationsInput["syncHealth"] extends (infer R)[] | null ? R : never> = {},
) {
  return {
    ml_account_id: contaId,
    resource,
    channel: "reconciliation",
    last_run_at: horasAtras(horasDesdeSucesso),
    last_run_status: "done",
    last_run_reason: null,
    last_success_at: horasAtras(horasDesdeSucesso),
    failed_24h: 0,
    runs_24h: 24,
    ...extra,
  };
}

/** Tudo saudável e OBSERVADO — a base que cada teste distorce num ponto. */
function base(): IntegrationsInput {
  return {
    now: NOW,
    viewerIsAdmin: true,
    mlAccounts: [
      { id: CONTA_1, label: "Loja 1", status: "CONNECTED", connected_at: horasAtras(48), last_error: null },
      { id: CONTA_2, label: "Loja 2", status: "CONNECTED", connected_at: horasAtras(2), last_error: null },
    ],
    syncHealth: [
      reconciliacao(CONTA_1, "orders", 0.5),
      reconciliacao(CONTA_1, "visits", 20, { runs_24h: 1 }),
      reconciliacao(CONTA_2, "orders", 0.5),
      // Backfill é finito: não entra no veredito de frescor (D-143).
      { ...reconciliacao(CONTA_1, "orders", 300), channel: "backfill", last_success_at: null },
    ],
    jobs: [
      { job_type: "system.ping", job_status: "done", job_last_run_at: horasAtras(0.5), job_age_hours: 0.5, job_failures_24h: 0 },
      {
        job_type: "sync.webhook.received",
        job_status: "done",
        job_last_run_at: horasAtras(0.1),
        job_age_hours: 0.1,
        job_failures_24h: 0,
      },
      {
        job_type: "sync.support.questions",
        job_status: "done",
        job_last_run_at: horasAtras(2),
        job_age_hours: 2,
        job_failures_24h: 0,
      },
      {
        job_type: "sync.support.messages",
        job_status: "done",
        job_last_run_at: horasAtras(3),
        job_age_hours: 3,
        job_failures_24h: 0,
      },
      {
        job_type: "maintenance.check-ai-budget",
        job_status: "done",
        job_last_run_at: horasAtras(6),
        job_age_hours: 6,
        job_failures_24h: 0,
      },
    ],
    migration: { version: "20260903160535", name: "settings_overview_rpc", applied_at: horasAtras(1), count: 135 },
    importBatches: [{ status: "APPLIED", created_at: horasAtras(24 * 14), last_error: null }],
    ai: { runsThisMonth: 12, lastRunAt: horasAtras(3), monthCostUsd: 0.4, budgetExceededAt: null },
    api: { configured: true, health: { commit: "6baa641", startedAt: horasAtras(1) } },
  };
}

function card(input: IntegrationsInput, id: string) {
  const found = describeIntegrations(input).find((c) => c.id === id);

  if (found === undefined) throw new Error(`card ${id} não existe`);

  return found;
}

/** Entradas ADVERSAS: tudo nulo, tudo vazio, tudo antigo, tudo falhando. */
function adversas(): IntegrationsInput[] {
  const nula: IntegrationsInput = {
    now: NOW,
    viewerIsAdmin: true,
    mlAccounts: null,
    syncHealth: null,
    jobs: null,
    migration: null,
    importBatches: null,
    ai: null,
    api: { configured: false, health: null },
  };
  const vazia: IntegrationsInput = { ...base(), mlAccounts: [], syncHealth: [], jobs: [], importBatches: [], ai: { runsThisMonth: 0, lastRunAt: null, monthCostUsd: 0, budgetExceededAt: null } };
  const antiga = base();
  antiga.syncHealth = [reconciliacao(CONTA_1, "orders", 400), reconciliacao(CONTA_2, "orders", 400)];
  antiga.jobs = antiga.jobs?.map((j) => ({ ...j, job_last_run_at: horasAtras(400), job_age_hours: 400 })) ?? null;
  antiga.ai = { runsThisMonth: 0, lastRunAt: horasAtras(2000), monthCostUsd: 0, budgetExceededAt: null };
  const falhando = base();
  falhando.jobs = falhando.jobs?.map((j) => ({ ...j, job_status: "failed", job_failures_24h: 8 })) ?? null;
  falhando.api = { configured: true, health: null };

  return [nula, vazia, antiga, falhando, base()];
}

describe("invariantes — valem para QUALQUER entrada", () => {
  it("nenhuma dimensão de configuração é ok, em nenhuma integração, em nenhuma entrada", () => {
    for (const entrada of adversas()) {
      for (const c of describeIntegrations(entrada)) {
        expect(c.configuration.state, c.id).not.toBe("ok");
      }
    }
  });

  it("ok exige atividade observada: toda dimensão ok tem observedAt e ele é recente", () => {
    for (const entrada of adversas()) {
      for (const c of describeIntegrations(entrada)) {
        for (const d of [c.connection, c.sync]) {
          if (d?.state === "ok") {
            expect(d.observedAt, c.id).not.toBeNull();
            expect(NOW.getTime() - new Date(d.observedAt ?? 0).getTime(), c.id).toBeLessThan(48 * 3_600_000);
          }
        }
      }
    }
  });

  it("entrada nula nunca produz ok em lugar nenhum, e toda integração aponta para uma tela dona", () => {
    const cards = describeIntegrations(adversas()[0]!);

    for (const c of cards) {
      expect(c.links.length).toBeGreaterThan(0);
      for (const d of [c.connection, c.sync, c.configuration]) {
        expect(d?.state ?? "nao_verificavel").not.toBe("ok");
      }
    }
  });

  it("dimensão que não se aplica é null, não um estado inventado", () => {
    const cards = describeIntegrations(base());

    expect(cards.find((c) => c.id === "upseller")?.connection).toBeNull();
    expect(cards.find((c) => c.id === "webhook")?.sync).toBeNull();
    expect(cards.find((c) => c.id === "supabase")?.sync).toBeNull();
  });

  it("uma tradução só de SyncVerdict: nunca é neutro, sem_cadencia é observado, critico é erro", () => {
    expect(fromVerdict("nunca")).toBe("sem_atividade");
    expect(fromVerdict("sem_cadencia")).toBe("observado");
    expect(fromVerdict("critico")).toBe("erro");
    expect(fromVerdict("ok")).toBe("ok");
  });
});

describe("Mercado Livre — conexão", () => {
  it("CONNECTED com sincronização recente em todas as contas é ok, e o instante é o do último SUCESSO, não do OAuth", () => {
    const ml = card(base(), "mercado_livre");

    expect(ml.connection?.state).toBe("ok");
    expect(ml.connection?.detail).toBe("2 conta(s) conectada(s), todas com sincronização recente");
    expect(ml.connection?.observedAt).toBe(horasAtras(0.5));
  });

  it("CONNECTED sem NENHUM run é flag, não atividade: sem_atividade, nunca ok — o caso da conta do seed", () => {
    const input = base();
    input.syncHealth = [];

    const ml = card(input, "mercado_livre");

    expect(ml.connection?.state).toBe("sem_atividade");
    expect(ml.connection?.detail).toContain("nenhuma chamada ao Mercado Livre bem-sucedida foi observada");
    expect(ml.connection?.detail).toContain("Loja 1, Loja 2");
  });

  it("CONNECTED com o último sucesso fora da cadência é atenção, com o nome da conta", () => {
    const input = base();
    input.syncHealth = [reconciliacao(CONTA_1, "orders", 0.5), reconciliacao(CONTA_2, "orders", 13)];

    const ml = card(input, "mercado_livre");

    expect(ml.connection?.state).toBe("atencao");
    expect(ml.connection?.detail).toContain("sem sucesso recente em: Loja 2");
  });

  it("REVOKED e ERROR são ditos com o nome do dono, separados, e o motivo sai SANITIZADO", () => {
    const input = base();
    input.mlAccounts = [
      { id: CONTA_1, label: "Loja 1", status: "REVOKED", connected_at: horasAtras(48), last_error: null },
      {
        id: CONTA_2,
        label: "GMR",
        status: "ERROR",
        connected_at: horasAtras(100),
        last_error: "Mercado Livre recusou a troca de token: invalid_client. refresh_token=TG-SEGREDO1234567890",
      },
    ];

    const ml = card(input, "mercado_livre");

    expect(ml.connection?.state).toBe("erro");
    expect(ml.connection?.detail).toContain("Loja 1 (acesso revogado)");
    expect(ml.connection?.detail).toContain("GMR (erro de conexão: Mercado Livre recusou");
    expect(ml.connection?.detail).not.toContain("TG-SEGREDO1234567890");
  });

  it("zero contas: para ADMIN é não configurado; para quem não é ADMIN é não verificável (a policy esconde)", () => {
    const admin = base();
    admin.mlAccounts = [];
    expect(card(admin, "mercado_livre").connection?.state).toBe("nao_configurado");

    const gestor = base();
    gestor.mlAccounts = [];
    gestor.viewerIsAdmin = false;
    expect(card(gestor, "mercado_livre").connection?.state).toBe("nao_verificavel");
  });
});

describe("Mercado Livre — sincronização", () => {
  it("tudo em dia e sem falhas é ok, e a contagem inclui os sem cadência", () => {
    const ml = card(base(), "mercado_livre");

    expect(ml.sync?.state).toBe("ok");
    expect(ml.sync?.detail).toBe("3 em dia, 0 atrasando, 0 atrasado(s), 0 nunca, 0 sem cadência");
  });

  it("o caso real de D-143 — visits com 85% de falha e um sucesso diário — NÃO é ok: o alerta do dono rebaixa para atenção", () => {
    const input = base();
    input.syncHealth = [
      reconciliacao(CONTA_1, "orders", 0.5),
      reconciliacao(CONTA_1, "visits", 20, { runs_24h: 145, failed_24h: 123 }),
    ];

    const ml = card(input, "mercado_livre");

    expect(ml.sync?.state).toBe("atencao");
    expect(ml.sync?.detail).toContain("visits: 123 de 145 execuções falharam (85%)");
  });

  it("recurso sem cadência mapeada (order_financials) falhando entra como alerta, não como soma muda", () => {
    const input = base();
    input.syncHealth = [
      reconciliacao(CONTA_1, "orders", 0.5),
      reconciliacao(CONTA_1, "order_financials", 5, {
        runs_24h: 16,
        failed_24h: 16,
        last_run_status: "failed",
        last_run_reason: 'Invalid input: expected object, received undefined at "amounts" access_token=APP_USR-1234567890123456',
      }),
    ];

    const ml = card(input, "mercado_livre");

    expect(ml.sync?.state).toBe("atencao");
    expect(ml.sync?.detail).toContain("1 sem cadência");
    expect(ml.sync?.detail).toContain("order_financials: 16 de 16 execuções falharam (100%)");
    expect(ml.sync?.detail).toContain("última falha: order_financials");
    expect(ml.sync?.detail).not.toContain("APP_USR-1234567890123456");
  });

  it("um recurso horário mudo há 13 h é erro — o cenário de D-217, com o veredito de D-143", () => {
    const input = base();
    input.syncHealth = [reconciliacao(CONTA_1, "orders", 13, { runs_24h: 0 })];

    expect(card(input, "mercado_livre").sync?.state).toBe("erro");
  });
});

describe("Webhook", () => {
  it("três fluxos processados há minutos/horas, dentro do silêncio medido de cada um: ok, e o texto diz 'processados pelo worker'", () => {
    const w = card(base(), "webhook");

    expect(w.connection?.state).toBe("ok");
    expect(w.connection?.detail).toContain("processados pelo worker");
    expect(w.connection?.detail).toContain("pedidos e pós-venda: há 0.1 h");
  });

  it("última execução FALHOU é erro, e falhas em 24h com sucesso recente é atenção — nunca ok verde", () => {
    const falhou = base();
    falhou.jobs = falhou.jobs?.map((j) => (j.job_type === "sync.webhook.received" ? { ...j, job_status: "failed" } : j)) ?? null;
    expect(card(falhou, "webhook").connection?.state).toBe("erro");

    const comFalhas = base();
    comFalhas.jobs = comFalhas.jobs?.map((j) => (j.job_type === "sync.webhook.received" ? { ...j, job_failures_24h: 3 } : j)) ?? null;
    const w = card(comFalhas, "webhook");
    expect(w.connection?.state).toBe("atencao");
    expect(w.connection?.detail).toContain("3 falha(s) em 24h");
  });

  it("silêncio: o veredito é o do dono (61 min medidos → 3 h é atenção, 5 h é erro)", () => {
    const tresHoras = base();
    tresHoras.jobs = tresHoras.jobs?.map((j) =>
      j.job_type === "sync.webhook.received" ? { ...j, job_last_run_at: horasAtras(3), job_age_hours: 3 } : j,
    ) ?? null;
    expect(card(tresHoras, "webhook").connection?.state).toBe("atencao");

    const cincoHoras = base();
    cincoHoras.jobs = cincoHoras.jobs?.map((j) =>
      j.job_type === "sync.webhook.received" ? { ...j, job_last_run_at: horasAtras(5), job_age_hours: 5 } : j,
    ) ?? null;
    expect(card(cincoHoras, "webhook").connection?.state).toBe("erro");
  });

  it("sem linhas de jobs (não ADMIN) é não verificável; com linhas mas sem webhook é sem atividade", () => {
    const naoAdmin = base();
    naoAdmin.jobs = null;
    expect(card(naoAdmin, "webhook").connection?.state).toBe("nao_verificavel");

    const nenhum = base();
    nenhum.jobs = [];
    expect(card(nenhum, "webhook").connection?.state).toBe("sem_atividade");
  });
});

describe("UpSeller", () => {
  it("lote APPLIED é atividade observada, sem verde; PARSED é 'Aguardando conferência' (ação humana), não 'em andamento'; FAILED é erro sanitizado", () => {
    expect(card(base(), "upseller").sync).toMatchObject({ state: "observado", detail: "último lote: Aplicado há 14 dia(s)" });

    const aguardando = base();
    aguardando.importBatches = [{ status: "PARSED", created_at: horasAtras(1), last_error: null }];
    const u = card(aguardando, "upseller");
    expect(u.sync?.state).toBe("atencao");
    expect(u.sync?.detail).toContain("Aguardando conferência");
    expect(u.sync?.detail).not.toContain("em andamento");

    const falhou = base();
    falhou.importBatches = [{ status: "FAILED", created_at: horasAtras(2), last_error: "planilha sem a coluna sku; apikey=XYZ12345678" }];
    const f = card(falhou, "upseller");
    expect(f.sync?.state).toBe("erro");
    expect(f.sync?.detail).toContain("planilha sem a coluna sku");
    expect(f.sync?.detail).not.toContain("XYZ12345678");
  });

  it("nunca importado é não configurado — e a página já excluiu os cancelados antes", () => {
    const input = base();
    input.importBatches = [];
    expect(card(input, "upseller").sync).toMatchObject({ state: "nao_configurado" });
  });
});

describe("IA / Copiloto", () => {
  it("uso no mês é observado (sob demanda não ganha verde), com chamadas e custo na MESMA janela", () => {
    const i = card(base(), "ia");

    expect(i.sync).toMatchObject({ state: "observado", detail: "12 chamada(s) no mês; US$ 0.40 no mês" });
  });

  it("teto ultrapassado (ai.budget.exceeded) é atenção; nenhuma chamada no mês é sem atividade, nunca ok", () => {
    const estourou = base();
    estourou.ai = { runsThisMonth: 40, lastRunAt: horasAtras(1), monthCostUsd: 19.2, budgetExceededAt: horasAtras(5) };
    expect(card(estourou, "ia").sync?.state).toBe("atencao");
    expect(card(estourou, "ia").sync?.detail).toContain("teto do mês ultrapassado");

    const parado = base();
    parado.ai = { runsThisMonth: 0, lastRunAt: horasAtras(2000), monthCostUsd: 0, budgetExceededAt: null };
    expect(card(parado, "ia").sync?.state).toBe("sem_atividade");
  });

  it("a conferência do teto é medida com a régua de /saude: em dia fica no detalhe; atrasada vira atenção na configuração", () => {
    expect(card(base(), "ia").configuration.state).toBe("nao_verificavel");
    expect(card(base(), "ia").configuration.detail).toContain("teto conferido há 6 h");

    const atrasada = base();
    atrasada.jobs = atrasada.jobs?.map((j) =>
      j.job_type === "maintenance.check-ai-budget" ? { ...j, job_last_run_at: horasAtras(120), job_age_hours: 120 } : j,
    ) ?? null;
    const c = card(atrasada, "ia");
    expect(c.configuration.state).toBe("atencao");
    expect(c.configuration.detail).toContain("conferência do teto");
  });
});

describe("Supabase e Google Cloud", () => {
  it("Supabase: conexão é FATO observado (a página leu sob RLS), e a migration lida entra no detalhe da configuração", () => {
    const s = card(base(), "supabase");

    expect(s.connection?.state).toBe("observado");
    expect(s.configuration.state).toBe("nao_verificavel");
    expect(s.configuration.detail).toContain("migration 20260903160535 (settings_overview_rpc) aplicada");
    expect(s.configuration.detail).toContain("135 no total");
  });

  it("Google Cloud: API e heartbeat em dia é ok; API muda é erro; heartbeat com última execução FALHA é erro; sem URL é não verificável", () => {
    expect(card(base(), "google_cloud").connection?.state).toBe("ok");

    const muda = base();
    muda.api = { configured: true, health: null };
    expect(card(muda, "google_cloud").connection?.state).toBe("erro");

    const pingFalhou = base();
    pingFalhou.jobs = pingFalhou.jobs?.map((j) => (j.job_type === "system.ping" ? { ...j, job_status: "failed" } : j)) ?? null;
    expect(card(pingFalhou, "google_cloud").connection?.state).toBe("erro");

    const semUrl = base();
    semUrl.api = { configured: false, health: null };
    expect(card(semUrl, "google_cloud").connection?.state).toBe("nao_verificavel");
  });

  it("heartbeat que nunca rodou é sem atividade (neutro, como 'Nunca rodou' em /saude), não 'não verificável'", () => {
    const input = base();
    input.jobs = input.jobs?.filter((j) => j.job_type !== "system.ping") ?? null;

    const g = card(input, "google_cloud");

    expect(g.connection?.state).toBe("sem_atividade");
    expect(g.connection?.detail).toContain("heartbeat nunca rodou");
  });
});

describe("o pior estado manda no agregado", () => {
  it("a ordem de severidade é erro > atenção > não verificável > sem atividade > não configurado > observado > ok", () => {
    const ordem: IntegrationState[] = ["erro", "atencao", "nao_verificavel", "sem_atividade", "nao_configurado", "observado", "ok"];
    // Google Cloud combina API e worker: worker erro + API ok = erro; API não
    // verificável + worker ok = não verificável.
    const w = base();
    w.jobs = w.jobs?.map((j) => (j.job_type === "system.ping" ? { ...j, job_status: "failed" } : j)) ?? null;
    expect(card(w, "google_cloud").connection?.state).toBe(ordem[0]);

    const a = base();
    a.api = { configured: false, health: null };
    expect(card(a, "google_cloud").connection?.state).toBe("nao_verificavel");
  });
});
