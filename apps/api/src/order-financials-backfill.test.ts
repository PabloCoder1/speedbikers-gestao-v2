import { createLogger } from "@sb/observability";
import { describe, expect, it, vi } from "vitest";

import type { EnqueueRequest, Enqueuer } from "./enqueue.js";
import type { OrderFinancialsBackfillDeps } from "./order-financials-backfill.js";
import { triggerOrderFinancialsBackfill } from "./order-financials-backfill.js";

const NOW = new Date("2026-09-23T15:00:00.000Z");

interface Conta {
  id: string;
  organization_id: string;
  slug: string;
}

/** Consulta encadeável que registra os filtros `eq` e resolve com as contas que casam. */
function fakeDb(contas: Conta[] | null): { db: OrderFinancialsBackfillDeps["db"]; filtros: [string, unknown][] } {
  const filtros: [string, unknown][] = [];

  function consulta(): unknown {
    const self = {
      eq: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);

        return self;
      },
      then: (resolve: (value: unknown) => unknown) => {
        if (contas === null) return Promise.resolve({ data: null, error: { message: "boom" } }).then(resolve);

        const slug = filtros.find(([coluna]) => coluna === "slug")?.[1];
        const data = slug === undefined ? contas : contas.filter((c) => c.slug === slug);

        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };

    return self;
  }

  const db = { from: () => ({ select: () => consulta() }) } as unknown as OrderFinancialsBackfillDeps["db"];

  return { db, filtros };
}

function fakeEnqueuer(deduplicated = false): { enqueuer: Enqueuer; requests: EnqueueRequest[] } {
  const requests: EnqueueRequest[] = [];

  const enqueuer: Enqueuer = {
    enqueue: vi.fn((request: EnqueueRequest) => {
      requests.push(request);

      return Promise.resolve({ taskName: "t", envelope: {} as never, deduplicated });
    }),
  };

  return { enqueuer, requests };
}

const CONTAS: Conta[] = [
  { id: "acc-1", organization_id: "org-1", slug: "loja-1" },
  { id: "acc-2", organization_id: "org-1", slug: "loja-2" },
];

describe("triggerOrderFinancialsBackfill (D-396)", () => {
  it("um primeiro pedaço por conta CONNECTED, na fila backfill, de onde a varredura diária termina até N dias atrás", async () => {
    const { db, filtros } = fakeDb(CONTAS);
    const { enqueuer, requests } = fakeEnqueuer();

    const outcome = await triggerOrderFinancialsBackfill(
      { db, enqueuer, logger: createLogger({}, { sink: () => undefined }), now: () => NOW },
      { dias: 90 },
    );

    expect(outcome).toEqual({
      accountsScanned: 2,
      enqueued: 2,
      deduplicated: 0,
      ate: "2026-09-16T15:00:00.000Z",
      limite: "2026-06-25T15:00:00.000Z",
    });
    expect(filtros).toEqual([["status", "CONNECTED"]]);
    expect(requests[0]).toEqual({
      jobType: "backfill.order-financials",
      organizationId: "org-1",
      dedupeKey: "backfill-order-financials:loja-1:inicio:2026-09-16:90",
      queue: "backfill",
      payload: { mlAccountId: "acc-1", ate: "2026-09-16T15:00:00.000Z", limite: "2026-06-25T15:00:00.000Z" },
    });
  });

  it("conta informada: ensaia numa conta só", async () => {
    const { db, filtros } = fakeDb(CONTAS);
    const { enqueuer, requests } = fakeEnqueuer();

    const outcome = await triggerOrderFinancialsBackfill(
      { db, enqueuer, logger: createLogger({}, { sink: () => undefined }), now: () => NOW },
      { dias: 30, conta: "loja-2" },
    );

    expect(outcome.enqueued).toBe(1);
    expect(filtros).toEqual([
      ["status", "CONNECTED"],
      ["slug", "loja-2"],
    ]);
    expect(requests.map((r) => r.payload)).toEqual([
      { mlAccountId: "acc-2", ate: "2026-09-16T15:00:00.000Z", limite: "2026-08-24T15:00:00.000Z" },
    ]);
  });

  it("disparo repetido no mesmo dia é deduplicado, e falha ao listar contas não lança", async () => {
    const repetido = fakeEnqueuer(true);
    const deps = { enqueuer: repetido.enqueuer, logger: createLogger({}, { sink: () => undefined }), now: () => NOW };

    expect(await triggerOrderFinancialsBackfill({ ...deps, db: fakeDb(CONTAS).db }, { dias: 90 })).toMatchObject({
      enqueued: 0,
      deduplicated: 2,
    });
    expect(await triggerOrderFinancialsBackfill({ ...deps, db: fakeDb(null).db }, { dias: 90 })).toMatchObject({
      accountsScanned: 0,
      enqueued: 0,
    });
  });
});
