import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { ListingSalesDropDeps } from "./listing-sales-drop.js";
import { createListingSalesDropHandler } from "./listing-sales-drop.js";

const ORG = "11111111-0000-4000-8000-000000000001";
const envelope = { jobId: "j1" } as never;

function fakeDb(resposta: { data: unknown; error: { message: string } | null }): {
  db: ListingSalesDropDeps["db"];
  chamadas: { fn: string; args: unknown }[];
} {
  const chamadas: { fn: string; args: unknown }[] = [];
  const db = {
    rpc: (fn: string, args: unknown) => {
      chamadas.push({ fn, args });

      return Promise.resolve(resposta);
    },
  } as unknown as ListingSalesDropDeps["db"];

  return { db, chamadas };
}

async function run(resposta: { data: unknown; error: { message: string } | null }, payload: unknown = { organizationId: ORG }) {
  const linhas: string[] = [];
  const logger = createLogger({}, { sink: (linha) => linhas.push(linha) });
  const { db, chamadas } = fakeDb(resposta);
  const outcome = await createListingSalesDropHandler({ db })(envelope, { payload, logger });

  return { outcome, chamadas, linhas };
}

describe("listing-sales-drop (D-629)", () => {
  it("chama o recálculo da organização e conta as linhas gravadas", async () => {
    const { outcome, chamadas, linhas } = await run({ data: { linhas: 30, em_queda: 2, periodo_ate: "2026-10-20" }, error: null });

    expect(chamadas).toEqual([{ fn: "recalcular_queda_anuncios", args: { p_organization_id: ORG } }]);
    expect(outcome).toEqual({ status: "done", processed: 30 });
    expect(linhas.join("")).toContain('"em_queda":2');
  });

  it("falha do banco volta para a fila; resposta fora do contrato, não", async () => {
    expect((await run({ data: null, error: { message: "statement timeout" } })).outcome).toEqual({
      status: "failed",
      retryable: true,
      reason: "recalcular_queda_anuncios: statement timeout",
    });
    expect((await run({ data: { linhas: "30" }, error: null })).outcome).toMatchObject({ status: "failed", retryable: false });
  });

  it("payload sem organização não chama o banco", async () => {
    const { outcome, chamadas } = await run({ data: null, error: null }, {});

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(chamadas).toEqual([]);
  });
});
