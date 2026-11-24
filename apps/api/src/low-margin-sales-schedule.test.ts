import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import type { EnqueueRequest } from "./enqueue.js";
import type { LowMarginSalesScheduleDeps } from "./low-margin-sales-schedule.js";
import { triggerLowMarginSalesDetection } from "./low-margin-sales-schedule.js";

/** O gatilho horário do alerta de venda abaixo da margem (D-858). */

const ORGS = [{ organization_id: "org-1" }, { organization_id: "org-2" }];

function deps(options: {
  falha?: boolean;
  deduplicaTudo?: boolean;
  organizations?: typeof ORGS;
  falhaDepoisDaPrimeiraPagina?: boolean;
} = {}): {
  deps: LowMarginSalesScheduleDeps;
  enqueued: EnqueueRequest[];
  filtros: [string, unknown][];
} {
  const enqueued: EnqueueRequest[] = [];
  const filtros: [string, unknown][] = [];
  const db = {
    from: (tabela: string) => ({
      select: () => ({
        eq: (coluna: string, valor: unknown) => {
          filtros.push([`${tabela}.${coluna}`, valor]);
          if (tabela === "ml_accounts") {
            return Promise.resolve({
              data: [{ id: "acc-1", organization_id: "org-1", slug: "loja-1" }],
              error: null,
            });
          }

          let cursor: string | undefined;
          const readPage = (limit: number) => {
            if (options.falha === true || (cursor !== undefined && options.falhaDepoisDaPrimeiraPagina === true)) {
              return Promise.resolve({ data: null, error: { message: "boom" } });
            }
            const data = (options.organizations ?? ORGS)
              .filter(({ organization_id }) => cursor === undefined || organization_id > cursor)
              .slice(0, Math.min(limit, 1000));
            return Promise.resolve({ data, error: null });
          };
          const query = {
            order: (column: string) => {
              expect(column).toBe("organization_id");
              return query;
            },
            gt: (column: string, value: string) => {
              expect(column).toBe("organization_id");
              cursor = value;
              return query;
            },
            limit: readPage,
          };
          return Object.assign(readPage(1000), query);
        },
      }),
    }),
  } as unknown as LowMarginSalesScheduleDeps["db"];

  return {
    enqueued,
    filtros,
    deps: {
      db,
      logger: createLogger({}, { sink: () => undefined }),
      now: () => new Date("2026-11-23T14:35:00.000Z"),
      enqueuer: {
        enqueue: (request) => {
          enqueued.push(request);

          return Promise.resolve({
            taskName: "t",
            deduplicated: options.deduplicaTudo === true,
            envelope: {
              jobType: request.jobType,
              jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
              organizationId: request.organizationId,
              dedupeKey: request.dedupeKey,
              attempt: 1,
              enqueuedAt: "2026-11-23T14:35:00.000Z",
            },
          });
        },
      },
    },
  };
}

describe("triggerLowMarginSalesDetection (D-858)", () => {
  it("um job por organização com o alerta ligado, com a hora cheia na chave", async () => {
    const { deps: d, enqueued, filtros } = deps();

    const outcome = await triggerLowMarginSalesDetection(d);

    expect(outcome).toEqual({ organizationsScanned: 2, enqueued: 2, deduplicated: 0 });
    expect(filtros).toEqual([["margin_alert_settings.enabled", true]]);
    expect(enqueued.map((e) => [e.jobType, e.queue, e.dedupeKey, e.payload])).toEqual([
      ["diagnostics.detect-low-margin-sales", "maintenance", "low-margin-sales:org-1:2026-11-23T14", { organizationId: "org-1" }],
      ["diagnostics.detect-low-margin-sales", "maintenance", "low-margin-sales:org-2:2026-11-23T14", { organizationId: "org-2" }],
    ]);
  });

  it("repetir na mesma hora é deduplicado e dito", async () => {
    const { deps: d } = deps({ deduplicaTudo: true });

    expect(await triggerLowMarginSalesDetection(d)).toEqual({ organizationsScanned: 2, enqueued: 0, deduplicated: 2 });
  });

  it("continua após falha parcial, responde 503 e deduplica a retentativa na mesma hora", async () => {
    const { deps: d, enqueued } = deps();
    const records: string[] = [];
    d.logger = createLogger({}, { sink: (line) => records.push(line) });
    const enqueue = d.enqueuer.enqueue;
    const accepted = new Set<string>();
    let failFirstOrg = true;

    d.enqueuer.enqueue = async (request) => {
      if (request.jobType === "diagnostics.detect-low-margin-sales" && request.organizationId === "org-1" && failFirstOrg) {
        failFirstOrg = false;
        throw new Error("fila indisponível");
      }
      const result = await enqueue(request);
      const deduplicated = accepted.has(request.dedupeKey);
      accepted.add(request.dedupeKey);
      return { ...result, deduplicated };
    };

    const app = createApp({
      logger: d.logger,
      metricsRefreshSchedule: d,
      oidc: { verify: () => Promise.resolve({ ok: true, email: "scheduler@exemplo.com" }) },
    });
    const run = () => app.request("/internal/schedule/metrics-refresh", { method: "POST" });

    const first = await run();
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({
      failed: true,
      enqueued: 2,
      alertaDeMargem: { organizationsScanned: 2, enqueued: 1, deduplicated: 0, failed: true },
    });
    expect(records.some((line) => line.includes("low_margin_sales_enqueue_failed") && line.includes("org-1"))).toBe(true);

    const retry = await run();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      enqueued: 0,
      deduplicated: 2,
      alertaDeMargem: { organizationsScanned: 2, enqueued: 1, deduplicated: 1 },
    });
    expect(enqueued.filter((request) => request.jobType === "diagnostics.detect-low-margin-sales")
      .map((request) => request.organizationId)).toEqual(["org-2", "org-1", "org-2"]);
  });

  it("sem conseguir listar, diz que falhou e não enfileira", async () => {
    const { deps: d, enqueued } = deps({ falha: true });

    expect(await triggerLowMarginSalesDetection(d)).toEqual({ organizationsScanned: 0, enqueued: 0, deduplicated: 0, failed: true });
    expect(enqueued).toEqual([]);
  });

  const organizations = Array.from({ length: 1001 }, (_, index) => ({
    organization_id: `org-${String(index).padStart(4, "0")}`,
  }));

  it("enfileira também a organização que ficou após o limite de 1.000 linhas", async () => {
    const { deps: d, enqueued } = deps({ organizations });
    expect(await triggerLowMarginSalesDetection(d)).toEqual({ organizationsScanned: 1001, enqueued: 1001, deduplicated: 0 });
    expect(enqueued.map((item) => item.organizationId)).toEqual(organizations.map((organization) => organization.organization_id));
  });

  it("falha se uma página posterior falhar antes de enfileirar qualquer organização", async () => {
    const { deps: d, enqueued } = deps({ organizations, falhaDepoisDaPrimeiraPagina: true });
    expect(await triggerLowMarginSalesDetection(d)).toEqual({ organizationsScanned: 0, enqueued: 0, deduplicated: 0, failed: true });
    expect(enqueued).toEqual([]);
  });
});
