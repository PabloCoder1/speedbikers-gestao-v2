import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import type { EnqueueRequest } from "./enqueue.js";
import type { OidcVerifier } from "./oidc.js";
import type { ShopeeOrdersScheduleDeps } from "./shopee-orders-schedule.js";
import { triggerShopeeOrdersSync } from "./shopee-orders-schedule.js";

const LOJAS = [
  { id: "aaaaaaaa-0000-4000-8000-0000000000a1", organization_id: "org-1" },
  { id: "aaaaaaaa-0000-4000-8000-0000000000a2", organization_id: "org-1" },
];

/** `shopee_shops` falsa que registra os filtros pedidos. */
function fakeDb(options: { falha?: boolean } = {}) {
  const filtros: [string, unknown][] = [];
  const query = {
    eq: (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);

      return query;
    },
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        options.falha === true ? { data: null, error: { message: "boom" } } : { data: LOJAS, error: null },
      ).then(resolve),
  };

  return {
    filtros,
    db: { from: () => ({ select: () => query }) } as unknown as ShopeeOrdersScheduleDeps["db"],
  };
}

function deps(options: { falha?: boolean; deduplicaLoja?: string } = {}) {
  const enqueued: EnqueueRequest[] = [];
  const { db, filtros } = fakeDb(options);
  const d: ShopeeOrdersScheduleDeps = {
    db,
    environment: "sandbox",
    logger: createLogger({}, { sink: () => undefined }),
    now: () => new Date("2026-10-13T15:20:00.000Z"),
    enqueuer: {
      enqueue: (request) => {
        enqueued.push(request);

        return Promise.resolve({
          taskName: "t",
          deduplicated: (request.payload as { shopeeShopId: string }).shopeeShopId === options.deduplicaLoja,
          envelope: {
            jobType: request.jobType,
            jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
            organizationId: request.organizationId,
            dedupeKey: request.dedupeKey,
            attempt: 1,
            enqueuedAt: "2026-10-13T15:20:00.000Z",
          },
        });
      },
    },
  };

  return { deps: d, enqueued, filtros };
}

describe("triggerShopeeOrdersSync (D-426, D-428)", () => {
  it("por loja CONECTADA do ambiente: pedidos e catálogo, na fila backfill, com a hora na chave", async () => {
    const { deps: d, enqueued, filtros } = deps();

    expect(await triggerShopeeOrdersSync(d)).toEqual({ shopsScanned: 2, enqueued: 4, deduplicated: 0 });
    expect(filtros).toEqual([
      ["status", "CONNECTED"],
      ["environment", "sandbox"],
    ]);
    expect(enqueued[0]).toEqual({
      jobType: "shopee.orders.sync",
      organizationId: "org-1",
      dedupeKey: `shopee-orders:${LOJAS[0]?.id ?? ""}:hora:2026-10-13T15`,
      queue: "backfill",
      payload: { shopeeShopId: LOJAS[0]?.id },
    });
    // D-428: o catálogo pega carona no mesmo gatilho, com chave própria.
    expect(enqueued[1]).toEqual({
      jobType: "shopee.items.sync",
      organizationId: "org-1",
      dedupeKey: `shopee-items:${LOJAS[0]?.id ?? ""}:hora:2026-10-13T15`,
      queue: "backfill",
      payload: { shopeeShopId: LOJAS[0]?.id },
      // Depois dos pedidos, que renovam o token primeiro.
      delaySeconds: 300,
    });
    expect(enqueued.map((e) => e.jobType)).toEqual([
      "shopee.orders.sync",
      "shopee.items.sync",
      "shopee.orders.sync",
      "shopee.items.sync",
    ]);
  });

  it("conta os deduplicados à parte", async () => {
    const { deps: d } = deps({ deduplicaLoja: LOJAS[1]?.id ?? "" });

    expect(await triggerShopeeOrdersSync(d)).toEqual({ shopsScanned: 2, enqueued: 2, deduplicated: 2 });
  });

  it("sem conseguir listar as lojas: falha, sem enfileirar", async () => {
    const { deps: d, enqueued } = deps({ falha: true });

    expect(await triggerShopeeOrdersSync(d)).toEqual({ shopsScanned: 0, enqueued: 0, deduplicated: 0, failed: true });
    expect(enqueued).toEqual([]);
  });
});

describe("POST /internal/schedule/shopee-orders (D-426)", () => {
  const aceitaTudo: OidcVerifier = { verify: () => Promise.resolve({ ok: true, email: "scheduler@exemplo.com" }) };
  const recusaTudo: OidcVerifier = { verify: () => Promise.resolve({ ok: false, reason: "token inválido" }) };
  const logger = createLogger({}, { sink: () => undefined });

  it("exige OIDC e responde 503 sem a Shopee configurada", async () => {
    const semOidc = await createApp({ logger, oidc: recusaTudo }).request("/internal/schedule/shopee-orders", {
      method: "POST",
    });
    const desligada = await createApp({ logger, oidc: aceitaTudo }).request("/internal/schedule/shopee-orders", {
      method: "POST",
    });

    expect(semOidc.status).toBe(401);
    expect(desligada.status).toBe(503);
  });

  it("dispara e devolve o resumo; sem listar as lojas é 503, para o Scheduler registrar falha", async () => {
    const ok = await createApp({ logger, oidc: aceitaTudo, shopeeOrdersSchedule: deps().deps }).request(
      "/internal/schedule/shopee-orders",
      { method: "POST" },
    );
    const falha = await createApp({ logger, oidc: aceitaTudo, shopeeOrdersSchedule: deps({ falha: true }).deps }).request(
      "/internal/schedule/shopee-orders",
      { method: "POST" },
    );

    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ shopsScanned: 2, enqueued: 4, deduplicated: 0 });
    expect(falha.status).toBe(503);
  });
});
