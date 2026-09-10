import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { EnqueueRequest } from "./enqueue.js";
import type { MetricsRefreshScheduleDeps } from "./metrics-refresh-schedule.js";
import { triggerMetricsRefresh } from "./metrics-refresh-schedule.js";

/**
 * O piso de frescor das métricas (D-304).
 *
 * O que estes casos guardam é a GARANTIA: o recálculo tem de acontecer mesmo
 * na hora em que ninguém vendeu nada. Antes, quem pedia recálculo era a chave
 * suja da reconciliação — e chave suja depende de venda.
 */

const ACCOUNTS = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", organization_id: "org-1", slug: "speedbikers-loja-1" },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", organization_id: "org-1", slug: "sbmotos" },
];

function fakeDb(options: { accountsFail?: boolean } = {}): MetricsRefreshScheduleDeps["db"] {
  return {
    from: () => ({
      select: () => ({
        eq: () =>
          Promise.resolve(
            options.accountsFail === true
              ? { data: null, error: { message: "boom" } }
              : { data: ACCOUNTS, error: null },
          ),
      }),
    }),
  } as unknown as MetricsRefreshScheduleDeps["db"];
}

/**
 * 2026-08-22T02:15Z é 23:15 do dia 21 em São Paulo — o instante que prova que
 * as datas são de NEGÓCIO e não de UTC. Um piso que usasse o dia UTC pediria
 * o recálculo do dia 22 enquanto a loja ainda vende no 21.
 */
function deps(options: { accountsFail?: boolean; deduplicaTudo?: boolean } = {}): {
  deps: MetricsRefreshScheduleDeps;
  enqueued: EnqueueRequest[];
} {
  const enqueued: EnqueueRequest[] = [];

  return {
    enqueued,
    deps: {
      db: fakeDb(options),
      logger: createLogger({}, { sink: () => undefined }),
      now: () => new Date("2026-08-22T02:15:00.000Z"),
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
              enqueuedAt: "2026-08-22T02:15:00.000Z",
            },
          });
        },
      },
    },
  };
}

describe("triggerMetricsRefresh (D-304)", () => {
  it("pede HOJE e ONTEM para cada conta CONNECTED, em data de NEGÓCIO", async () => {
    const { deps: d, enqueued } = deps();

    const outcome = await triggerMetricsRefresh(d);

    expect(outcome).toEqual({
      accountsScanned: 2,
      enqueued: 4,
      deduplicated: 0,
      // 02:15 UTC ainda é dia 21 em São Paulo: hoje = 21, ontem = 20.
      dates: ["2026-08-20", "2026-08-21"],
    });

    expect(enqueued.map((e) => e.dedupeKey)).toEqual([
      "refresh:speedbikers-loja-1:2026-08-20:2026-08-22T02",
      "refresh:speedbikers-loja-1:2026-08-21:2026-08-22T02",
      "refresh:sbmotos:2026-08-20:2026-08-22T02",
      "refresh:sbmotos:2026-08-21:2026-08-22T02",
    ]);
  });

  it("o trabalho é o MESMO job de sempre — nenhum tipo novo entra no roteador", async () => {
    const { deps: d, enqueued } = deps();

    await triggerMetricsRefresh(d);

    expect(new Set(enqueued.map((e) => e.jobType))).toEqual(new Set(["analytics.recompute"]));
    expect(new Set(enqueued.map((e) => e.queue))).toEqual(new Set(["analytics-recompute"]));
    expect(enqueued[0]?.payload).toEqual({
      mode: "incremental",
      mlAccountId: ACCOUNTS[0]?.id,
      metricDate: "2026-08-20",
    });
  });

  /*
    A CHAVE NÃO COLIDE COM A DA RECONCILIAÇÃO, e isso é deliberado: ela usa o
    prefixo `recompute:`. As duas precisam poder pedir a MESMA data na mesma
    hora — recalcular duas vezes custa uma passada que não escreve nada
    (D-199), e perder o piso porque a outra chegou primeiro custaria a
    garantia inteira.
  */
  it("a chave é a do PISO, não a da chave suja", async () => {
    const { deps: d, enqueued } = deps();

    await triggerMetricsRefresh(d);

    expect(enqueued.every((e) => e.dedupeKey.startsWith("refresh:"))).toBe(true);
    expect(enqueued.some((e) => e.dedupeKey.startsWith("recompute:"))).toBe(false);
  });

  /** Chamar duas vezes na mesma hora não dobra trabalho — a hora está na chave. */
  it("repetição dentro da mesma hora é deduplicada, e isso é DITO", async () => {
    const { deps: d } = deps({ deduplicaTudo: true });

    const outcome = await triggerMetricsRefresh(d);

    expect(outcome.enqueued).toBe(0);
    expect(outcome.deduplicated).toBe(4);
  });

  /** Falha ao listar contas não vira exceção: vira zero enfileirado e log. */
  it("se as contas não puderem ser lidas, o piso não finge ter rodado", async () => {
    const { deps: d, enqueued } = deps({ accountsFail: true });

    const outcome = await triggerMetricsRefresh(d);

    expect(outcome.accountsScanned).toBe(0);
    expect(outcome.enqueued).toBe(0);
    expect(enqueued).toEqual([]);
  });
});
