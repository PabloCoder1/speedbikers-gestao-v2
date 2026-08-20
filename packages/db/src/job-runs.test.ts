import { describe, expect, it, vi } from "vitest";

import type { AdminClient } from "./admin-client.js";
import type { JobRunInsert } from "./job-runs.js";
import { recordJobRun } from "./job-runs.js";

const RUN: JobRunInsert = {
  organization_id: "00000000-0000-4000-8000-000000000000",
  job_id: "22222222-2222-4222-8222-222222222222",
  job_type: "system.ping",
  dedupe_key: "ping:teste",
  attempt: 1,
  status: "done",
  started_at: "2026-08-20T13:00:00.000Z",
  finished_at: "2026-08-20T13:00:01.000Z",
};

/** Cliente mínimo com o formato que `recordJobRun` usa. */
function fakeClient(insert: () => Promise<{ error: { message: string } | null }>): {
  client: AdminClient;
  from: ReturnType<typeof vi.fn>;
} {
  const from = vi.fn(() => ({ insert }));

  return { client: { from } as unknown as AdminClient, from };
}

describe("recordJobRun", () => {
  it("grava na tabela job_runs", async () => {
    const { client, from } = fakeClient(() => Promise.resolve({ error: null }));

    await recordJobRun(client, RUN);

    expect(from).toHaveBeenCalledWith("job_runs");
  });

  it("devolve ok quando a gravação funciona", async () => {
    const { client } = fakeClient(() => Promise.resolve({ error: null }));

    expect(await recordJobRun(client, RUN)).toEqual({ ok: true });
  });

  it("NÃO lança quando a gravação falha", async () => {
    // Esta é a garantia central. Lançar aqui faria o worker devolver 5xx, o
    // Cloud Tasks repetir, e um trabalho já concluído ser refeito por causa de
    // uma falha de observabilidade.
    const { client } = fakeClient(() =>
      Promise.resolve({ error: { message: "connection reset" } }),
    );

    await expect(recordJobRun(client, RUN)).resolves.toEqual({
      ok: false,
      reason: "connection reset",
    });
  });

  it("propaga o motivo da falha para quem chamou decidir", async () => {
    const { client } = fakeClient(() =>
      Promise.resolve({ error: { message: "permission denied for table job_runs" } }),
    );

    const result = await recordJobRun(client, RUN);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("permission denied");
  });

  it("grava exatamente uma vez por chamada", async () => {
    const insert = vi.fn(() => Promise.resolve({ error: null }));
    const { client } = fakeClient(insert);

    await recordJobRun(client, RUN);

    expect(insert).toHaveBeenCalledTimes(1);
  });
});
