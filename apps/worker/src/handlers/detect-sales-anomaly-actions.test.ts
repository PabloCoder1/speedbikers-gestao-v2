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
  marketplace: "ML",
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
  marketplace: "ML",
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
  events?: { sku_id: string; event_type: string; occurred_at: string; marketplace: string | null }[];
  eventsFails?: boolean;
  prices?: { sku_id: string; average_price: number; marketplace: string }[];
  pricesFail?: boolean;
  cicloFails?: boolean;
}): {
  deps: DetectSalesAnomalyActionsDeps;
  upserted: Record<string, unknown>[];
  lines: string[];
  args: Record<string, Record<string, unknown>>;
} {
  const upserted: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const args: Record<string, Record<string, unknown>> = {};

  const baseline = options.baseline ?? [ANOMALY_ROW];
  const events = options.events ?? [];
  const prices = options.prices ?? [{ sku_id: "sku-a", average_price: 50, marketplace: "ML" }];

  const db = {
    rpc: (fn: string, rpcArgs: Record<string, unknown>) => {
      args[fn] = rpcArgs;

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

      // D-152: a correlação virou RPC (fonte única com /diagnostico e o
      // painel do SKU) — linhas já chegam mapeadas por sku_id.
      if (fn === "get_sku_correlated_events") {
        return Promise.resolve(
          options.eventsFails === true ? { data: null, error: { message: "boom" } } : { data: events, error: null },
        );
      }

      // D-643: as detecções do dia vão ao ciclo de episódio, não a `actions`.
      if (fn === "registrar_vendas_anomalas") {
        upserted.push(...(rpcArgs.p_detectadas as Record<string, unknown>[]));

        return Promise.resolve(
          options.cicloFails === true ? { data: null, error: { message: "boom" } } : { data: { criadas: 0 }, error: null },
        );
      }

      throw new Error(`rpc inesperada no fake: ${fn}`);
    },
    from: (table: string) => {
      // D-116 — sinal de SAC: vazio por padrão nos testes de anomalia; a
      // presença de claims tem teste próprio.
      if (table === "support_case_links") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          neq: () => Promise.resolve({ data: [], error: null }),
        };

        return chain;
      }

      throw new Error(`tabela inesperada no fake: ${table}`);
    },
  } as unknown as DetectSalesAnomalyActionsDeps["db"];

  return { deps: { db, now: () => NOW }, upserted, lines, args };
}

function ctx(lines: string[], payload: unknown): { logger: ReturnType<typeof createLogger>; payload: unknown } {
  return { logger: createLogger({}, { sink: (line) => lines.push(line) }), payload };
}

describe("detecção de anomalia de venda vira ação (Fase 6, D-064)", () => {
  it("sem SKU em anomalia: done com zero e o ciclo roda vazio (D-643: é ele que encerra os episódios), sem consultar eventos/preço", async () => {
    const { deps, upserted, lines, args } = fakeDeps({ baseline: [STABLE_ROW] });

    const outcome = await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(upserted).toHaveLength(0);
    expect(args.registrar_vendas_anomalas).toEqual({ p_organization_id: ORG_ID, p_hoje: AS_OF, p_detectadas: [] });
    expect(args.get_sku_correlated_events).toBeUndefined();
  });

  it("SKU em anomalia (queda): vai ao ciclo como a detecção do episódio ML:<sku>, com o impacto estimado", async () => {
    const { deps, upserted, lines, args } = fakeDeps({});

    const outcome = await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(args.registrar_vendas_anomalas).toMatchObject({ p_organization_id: ORG_ID, p_hoje: AS_OF });
    expect(upserted).toHaveLength(1);
    expect(upserted[0]).toMatchObject({
      subject_key: "ML:sku-a",
      severity: "alta",
      confidence: "alta",
      sku_id: "sku-a",
      // current=0, mean=3 -> |delta|=3, preço médio=50 -> 150.
      impacto: 150,
    });
  });

  it("sem preço médio disponível para o SKU: impacto null, não zero", async () => {
    const { deps, upserted, lines } = fakeDeps({ prices: [] });

    await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(upserted[0]?.impacto).toBeNull();
  });

  it("evento correlato entra na evidência", async () => {
    const { deps, upserted, lines } = fakeDeps({
      events: [{ sku_id: "sku-a", event_type: "stock.depleted", occurred_at: "2026-08-22T21:00:00.000Z", marketplace: null }],
    });

    await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    const evidence = upserted[0]?.evidence as { causas_candidatas: { event_type: string }[] };

    expect(evidence.causas_candidatas).toHaveLength(1);
    expect(evidence.causas_candidatas[0]?.event_type).toBe("stock.depleted");
  });

  it("C-83: pede os dois canais às três RPCs", async () => {
    const { deps, lines, args } = fakeDeps({});

    await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    for (const fn of ["get_sku_sales_baseline", "get_sku_correlated_events", "get_sku_average_prices"]) {
      expect(args[fn]?.p_marketplaces).toEqual(["ML", "SHOPEE"]);
    }
  });

  it("C-83: a queda só na Shopee vira o episódio dela, com o canal, o assunto e o preço da Shopee", async () => {
    const { deps, upserted, lines } = fakeDeps({
      baseline: [STABLE_ROW, { ...ANOMALY_ROW, marketplace: "SHOPEE" }, { ...STABLE_ROW, sku_id: "sku-a", marketplace: "ML" }],
      prices: [
        { sku_id: "sku-a", average_price: 50, marketplace: "ML" },
        { sku_id: "sku-a", average_price: 40, marketplace: "SHOPEE" },
      ],
    });

    const outcome = await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(upserted).toHaveLength(1);
    expect(upserted[0]).toMatchObject({
      sku_id: "sku-a",
      subject_key: "SHOPEE:sku-a",
      // |delta| = 3, o preço médio da Shopee = 40.
      impacto: 120,
    });
    expect((upserted[0]?.evidence as { marketplace: string }).marketplace).toBe("SHOPEE");
  });

  it("C-83: a queda nos dois canais são dois episódios; o evento do SKU vale para os dois, o do canal só para o dele", async () => {
    const { deps, upserted, lines } = fakeDeps({
      baseline: [ANOMALY_ROW, { ...ANOMALY_ROW, marketplace: "SHOPEE" }],
      events: [
        { sku_id: "sku-a", event_type: "stock.depleted", occurred_at: "2026-08-22T21:00:00.000Z", marketplace: null },
        { sku_id: "sku-a", event_type: "listing.status.paused", occurred_at: "2026-08-22T22:00:00.000Z", marketplace: "ML" },
        { sku_id: "sku-a", event_type: "listing.price.changed", occurred_at: "2026-08-22T23:00:00.000Z", marketplace: "SHOPEE" },
      ],
    });

    await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    const causas = (canal: string) =>
      (upserted.find((row) => (row.evidence as { marketplace: string }).marketplace === canal)?.evidence as {
        causas_candidatas: { event_type: string }[];
      }).causas_candidatas.map((causa) => causa.event_type);

    expect(upserted.map((row) => row.subject_key)).toEqual(["ML:sku-a", "SHOPEE:sku-a"]);
    expect(causas("ML")).toEqual(["stock.depleted", "listing.status.paused"]);
    expect(causas("SHOPEE")).toEqual(["stock.depleted", "listing.price.changed"]);
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

  it("falha no ciclo de episódio é retryable", async () => {
    const { deps, lines } = fakeDeps({ cicloFails: true });

    const outcome = await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { organizationId: ORG_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("payload sem organizationId é falha definitiva", async () => {
    const { deps, lines } = fakeDeps({});

    const outcome = await createDetectSalesAnomalyActionsHandler(deps)(ENVELOPE, ctx(lines, { nada: true }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });
});
