import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { DetectSalesAnomalyActionsDeps } from "./detect-sales-anomaly-actions.js";
import { createDetectSalesAnomalyActionsHandler } from "./detect-sales-anomaly-actions.js";

const ORG_ID = "11111111-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-24T09:00:00.000-03:00");
// `shiftBusinessDate(toSalesMetricDate(NOW), -1)`: NOW é 24/08 (Brasília), o
// job olha para ONTEM — mesmo raciocínio de `/diagnostico/page.tsx`.
const AS_OF = "2026-08-23";

const ENVELOPE = {
  jobType: "diagnostics.detect-sales-anomalies",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b22",
  organizationId: ORG_ID,
  dedupeKey: `detect-sales-anomalies:${ORG_ID}:${AS_OF}`,
  attempt: 1,
  enqueuedAt: "2026-08-24T09:00:00.000Z",
};

const ANOMALY_ROW = {
  sku_id: "sku-a",
  sku: "SKU-A",
  title: "Produto A",
  weekday: 0,
  current_units_sold: 0,
  baseline_mean: 3,
  baseline_stddev: 0.5,
  sample_count: 8,
};

const STABLE_ROW = {
  sku_id: "sku-b",
  sku: "SKU-B",
  title: "Produto B",
  weekday: 0,
  current_units_sold: 3,
  baseline_mean: 3,
  baseline_stddev: 0.5,
  sample_count: 8,
};

function fakeDeps(options: {
  baseline?: typeof ANOMALY_ROW[];
  baselineFails?: boolean;
  events?: { entity_id: string; event_type: string; occurred_at: string }[];
  eventsFails?: boolean;
  prices?: { sku_id: string; average_price: number }[];
  pricesFail?: boolean;
  upsertFails?: boolean;
}): { deps: DetectSalesAnomalyActionsDeps; upserted: Record<string, unknown>[]; lines: string[] } {
  const upserted: Record<string, unknown>[] = [];
  const lines: string[] = [];

  const baseline = options.baseline ?? [ANOMALY_ROW];
  const events = options.events ?? [];
  const prices = options.prices ?? [{ sku_id: "sku-a", average_price: 50 }];

  const db = {
    rpc: (fn: string) => {
      if (fn === "get_sku_sales_baseline") {
        return Promise.resolve(
          options.baselineFails === true ? { data: null, error: { message: "boom" } } : { data: baseline, error: null },
        );
      }

      if (fn === "get_sku_average_prices") {
        return Promise.resolve(
          options.pricesFail === true ? { data: null, error: { message: "boom" } } : { data: prices, error: null },
        );
      }

      throw new Error(`rpc inesperada no fake: ${fn}`);
    },
    from: (table: string) => {
      if (table === "domain_events") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: () => ({
                  gte: () => ({
                    lt: () =>
                      Promise.resolve(
                        options.eventsFails === true
                          ? { data: null, error: { message: "boom" } }
                          : { data: events, error: null },
                      ),
                  }),
                }),
              }),
            }),
          }),
        };
      }

      if (table === "actions") {
        return {
          upsert: (rows: Record<string, unknown>[]) => {
            upserted.push(...rows);

            return Promise.resolve(
              options.upsertFails === true ? { error: { message: "boom" } } : { error: null },
            );
          },
        };
      }

      throw new Error(`tabela inesperada no fake: ${table}`);
    },
  } as unknown as DetectSalesAnomalyActionsDeps["db"];

  return { deps: { db, now: () => NOW }, upserted, lines };
}

function ctx(lines: string[], payload: unknown): { logger: ReturnType<typeof createLogger>; payload: unknown } {
  return { logger: createLogger({}, { sink: (line) => lines.push(line) }), payload };
}

describe("detecção de anomalia de venda vira ação (Fase 6, D-064)", () => {
  it("sem SKU em anomalia: done com zero, nada gravado, nem consulta eventos/preço", async () => {
    const { deps, upserted, lines } = fakeDeps({ baseline: [STABLE_ROW] });

    const outcome = await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(upserted).toHaveLength(0);
  });

  it("SKU em anomalia (queda): grava uma ação com impacto estimado e dedup_key por dia", async () => {
    const { deps, upserted, lines } = fakeDeps({});

    const outcome = await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(upserted).toHaveLength(1);
    expect(upserted[0]).toMatchObject({
      organization_id: ORG_ID,
      kind: "venda_anomala",
      severity: "alta",
      confidence: "alta",
      sku_id: "sku-a",
      created_by: "system",
      dedup_key: `sales_anomaly:sku-a:${AS_OF}`,
      // current=0, mean=3 -> |delta|=3, preço médio=50 -> 150.
      estimated_impact_brl: 150,
    });
    expect(upserted[0]?.status).toBeUndefined();
  });

  it("sem preço médio disponível para o SKU: impacto null, não zero", async () => {
    const { deps, upserted, lines } = fakeDeps({ prices: [] });

    await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(upserted[0]?.estimated_impact_brl).toBeNull();
  });

  it("evento correlato entra na evidência", async () => {
    const { deps, upserted, lines } = fakeDeps({
      events: [{ entity_id: "sku-a", event_type: "stock.depleted", occurred_at: "2026-08-22T21:00:00.000Z" }],
    });

    await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    const evidence = upserted[0]?.evidence as { causas_candidatas: { event_type: string }[] };

    expect(evidence.causas_candidatas).toHaveLength(1);
    expect(evidence.causas_candidatas[0]?.event_type).toBe("stock.depleted");
  });

  it("falha ao ler o baseline é retryable", async () => {
    const { deps, lines } = fakeDeps({ baselineFails: true });

    const outcome = await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("falha ao ler domain_events é retryable", async () => {
    const { deps, lines } = fakeDeps({ eventsFails: true });

    const outcome = await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("falha ao ler preços é retryable", async () => {
    const { deps, lines } = fakeDeps({ pricesFail: true });

    const outcome = await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("falha ao gravar em actions é retryable", async () => {
    const { deps, lines } = fakeDeps({ upsertFails: true });

    const outcome = await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("payload sem organizationId é falha definitiva", async () => {
    const { deps, lines } = fakeDeps({});

    const outcome = await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { nada: true }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });
});
