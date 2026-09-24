import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { SyncCentralAlertsDeps } from "./sync-central-alerts.js";
import { createSyncCentralAlertsHandler } from "./sync-central-alerts.js";

const ORG = "11111111-0000-4000-8000-000000000001";
const envelope = { jobId: "j1" } as never;

function resultado(fonte: string, criadas: number) {
  return {
    hoje: "2026-09-24",
    fontes: [fonte],
    detectados: { [fonte]: criadas + 1 },
    atualizadas: 1,
    continuas: 0,
    criadas,
    encerradas: 0,
  };
}

interface Resposta {
  data: unknown;
  error: { message: string } | null;
}

function fakeDb(porFonte: Record<string, Resposta>): {
  db: SyncCentralAlertsDeps["db"];
  chamadas: { fn: string; args: { p_organization_id: string; p_fontes: string[] } }[];
} {
  const chamadas: { fn: string; args: { p_organization_id: string; p_fontes: string[] } }[] = [];
  const db = {
    rpc: (fn: string, args: { p_organization_id: string; p_fontes: string[] }) => {
      chamadas.push({ fn, args });

      return Promise.resolve(porFonte[args.p_fontes[0] ?? ""] ?? { data: null, error: { message: "sem resposta" } });
    },
  } as unknown as SyncCentralAlertsDeps["db"];

  return { db, chamadas };
}

const TUDO_CERTO: Record<string, Resposta> = {
  frete_anomalo: { data: resultado("frete_anomalo", 2), error: null },
  ads_campanha: { data: resultado("ads_campanha", 1), error: null },
  produto_prejuizo: { data: resultado("produto_prejuizo", 0), error: null },
};

async function run(porFonte: Record<string, Resposta>, payload: unknown = { organizationId: ORG }) {
  const linhas: string[] = [];
  const logger = createLogger({}, { sink: (linha) => linhas.push(linha) });
  const { db, chamadas } = fakeDb(porFonte);
  const outcome = await createSyncCentralAlertsHandler({ db })(envelope, { payload, logger });

  return { outcome, chamadas, linhas };
}

describe("sync-central-alerts (D-403, D-404)", () => {
  it("uma chamada por fonte, a do frete primeiro, e conta o que mudou em todas", async () => {
    const { outcome, chamadas, linhas } = await run(TUDO_CERTO);

    expect(chamadas).toEqual([
      { fn: "sincronizar_alertas_central", args: { p_organization_id: ORG, p_fontes: ["frete_anomalo"] } },
      { fn: "sincronizar_alertas_central", args: { p_organization_id: ORG, p_fontes: ["ads_campanha"] } },
      { fn: "sincronizar_alertas_central", args: { p_organization_id: ORG, p_fontes: ["produto_prejuizo"] } },
    ]);
    // (2 + 1) + (1 + 1) + (0 + 1): criadas e atualizadas de cada fonte.
    expect(outcome).toEqual({ status: "done", processed: 6 });
    expect(linhas.filter((l) => l.includes("sync_central_alerts_done"))).toHaveLength(3);
    expect(linhas.join("")).toContain('"detectados":{"frete_anomalo":3}');
  });

  it("uma fonte que estoura o tempo não impede as outras, e o job volta para a fila", async () => {
    const { outcome, chamadas, linhas } = await run({
      ...TUDO_CERTO,
      frete_anomalo: { data: null, error: { message: "canceling statement due to statement timeout" } },
    });

    expect(chamadas).toHaveLength(3);
    expect(linhas.filter((l) => l.includes("sync_central_alerts_done"))).toHaveLength(2);
    expect(outcome).toEqual({
      status: "failed",
      retryable: true,
      reason: "frete_anomalo: canceling statement due to statement timeout",
    });
  });

  it("resposta fora do contrato não é repetida: a transação já gravou", async () => {
    const { outcome } = await run({ ...TUDO_CERTO, ads_campanha: { data: { hoje: "2026-09-24" }, error: null } });

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });

  it("payload sem organização não chama o banco", async () => {
    const { outcome, chamadas } = await run(TUDO_CERTO, {});

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(chamadas).toEqual([]);
  });
});
