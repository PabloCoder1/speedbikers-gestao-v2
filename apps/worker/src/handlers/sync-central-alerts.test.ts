import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { SyncCentralAlertsDeps } from "./sync-central-alerts.js";
import { createSyncCentralAlertsHandler } from "./sync-central-alerts.js";

const ORG = "11111111-0000-4000-8000-000000000001";
const envelope = { jobId: "j1" } as never;

const RESULTADO = {
  hoje: "2026-09-24",
  fontes: ["frete_anomalo", "ads_campanha", "produto_prejuizo"],
  detectados: { frete_anomalo: 3, ads_campanha: 2 },
  atualizadas: 2,
  continuas: 1,
  criadas: 2,
  encerradas: 1,
};

function fakeDb(resposta: { data: unknown; error: { message: string } | null }): {
  db: SyncCentralAlertsDeps["db"];
  chamadas: { fn: string; args: unknown }[];
} {
  const chamadas: { fn: string; args: unknown }[] = [];
  const db = {
    rpc: (fn: string, args: unknown) => {
      chamadas.push({ fn, args });

      return Promise.resolve(resposta);
    },
  } as unknown as SyncCentralAlertsDeps["db"];

  return { db, chamadas };
}

async function run(resposta: Parameters<typeof fakeDb>[0], payload: unknown = { organizationId: ORG }) {
  const linhas: string[] = [];
  const logger = createLogger({}, { sink: (linha) => linhas.push(linha) });
  const { db, chamadas } = fakeDb(resposta);
  const outcome = await createSyncCentralAlertsHandler({ db })(envelope, { payload, logger });

  return { outcome, chamadas, linhas };
}

describe("sync-central-alerts (D-403)", () => {
  it("chama a função da organização e conta o que mudou", async () => {
    const { outcome, chamadas, linhas } = await run({ data: RESULTADO, error: null });

    expect(chamadas).toEqual([{ fn: "sincronizar_alertas_central", args: { p_organization_id: ORG } }]);
    // Criadas, atualizadas e encerradas; "continuas" é só a anotação de continuidade.
    expect(outcome).toEqual({ status: "done", processed: 5 });
    expect(linhas.join("")).toContain('"detectados":{"frete_anomalo":3,"ads_campanha":2}');
  });

  it("erro do banco é retryable, nunca 'done, 0 alertas'", async () => {
    const { outcome } = await run({ data: null, error: { message: "statement timeout" } });

    expect(outcome).toMatchObject({ status: "failed", retryable: true, reason: "statement timeout" });
  });

  it("resposta fora do contrato não é repetida: a transação já gravou", async () => {
    const { outcome } = await run({ data: { hoje: "2026-09-24" }, error: null });

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });

  it("payload sem organização não chama o banco", async () => {
    const { outcome, chamadas } = await run({ data: RESULTADO, error: null }, {});

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(chamadas).toEqual([]);
  });
});
