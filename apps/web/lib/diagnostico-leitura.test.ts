import { describe, expect, it } from "vitest";

import {
  DIAGNOSTICO_CHUNK,
  lerBaselineDoDiagnostico,
  lerEvidenciasDoDiagnostico,
  lerPrecosMediosDoDiagnostico,
  type BaselineRow,
} from "./diagnostico-leitura";

const ORG = "11111111-0000-4000-8000-000000000001";
const AS_OF = "2026-10-20";
const POSTGREST_CAP = 1000;

type Supabase = Parameters<typeof lerBaselineDoDiagnostico>[0];

function makeQuery(
  rows: readonly unknown[],
  options: {
    error?: { message: string } | null;
    comCount?: boolean;
    onOrder?: (cols: string[]) => void;
  } = {},
) {
  let from = 0;
  let to = Number.POSITIVE_INFINITY;
  const cols: string[] = [];

  const chain = {
    eq: () => chain,
    neq: () => chain,
    order: (col: string) => {
      cols.push(col);

      return chain;
    },
    range: (start: number, end: number) => {
      from = start;
      to = end;

      return chain;
    },
    then: <R1, R2>(resolve?: (value: unknown) => R1, reject?: (reason: unknown) => R2) => {
      options.onOrder?.(cols);

      if (options.error) {
        return Promise.resolve({ data: null, error: options.error, count: null }).then(resolve, reject);
      }

      const end = Math.min(to + 1, from + POSTGREST_CAP);

      return Promise.resolve({
        data: rows.slice(from, end),
        error: null,
        count: options.comCount ? rows.length : null,
      }).then(resolve, reject);
    },
  };

  return chain;
}

function fakeSupabase(config: {
  baseline?: BaselineRow[];
  events?: { sku_id: string; event_type: string; occurred_at: string; marketplace: string | null }[];
  prices?: { sku_id: string; average_price: number; marketplace: string }[];
  claims?: { sku_id: string; support_case_id: string }[];
  claimsFailOnSecondChunk?: boolean;
}) {
  const orderedBy: Record<string, string[][]> = {};
  const claimInSizes: number[] = [];
  const rpcCalls: string[] = [];
  let claimCall = 0;

  const note = (name: string) => (cols: string[]) => {
    (orderedBy[name] ??= []).push([...cols]);
  };

  const supabase = {
    rpc: (fn: string, _args: Record<string, unknown>, opts?: { count?: "exact" }) => {
      rpcCalls.push(fn);

      if (fn === "get_sku_sales_baseline") {
        return makeQuery(config.baseline ?? [], { comCount: opts?.count === "exact", onOrder: note(fn) });
      }

      if (fn === "get_sku_correlated_events") {
        return makeQuery(config.events ?? [], { comCount: opts?.count === "exact", onOrder: note(fn) });
      }

      if (fn === "get_sku_average_prices") {
        return makeQuery(config.prices ?? [], { comCount: opts?.count === "exact", onOrder: note(fn) });
      }

      throw new Error(`rpc inesperada: ${fn}`);
    },
    from: (table: string) => {
      if (table !== "support_case_links") {
        throw new Error(`tabela inesperada: ${table}`);
      }

      let skuIds: Set<string> | null = null;
      let comCount = false;

      const builder = {
        select: (_cols: string, opts?: { count?: "exact" }) => {
          comCount = opts?.count === "exact";

          return builder;
        },
        in: (_col: string, values: string[]) => {
          claimInSizes.push(values.length);
          skuIds = new Set(values);

          return builder;
        },
        eq: () => builder,
        neq: () => {
          claimCall += 1;
          const fail = config.claimsFailOnSecondChunk === true && claimCall === 2;
          const rows = (config.claims ?? []).filter((r) => skuIds === null || skuIds.has(r.sku_id));

          return makeQuery(rows, {
            comCount,
            error: fail ? { message: "falha no lote 2 de SAC" } : null,
            onOrder: note("support_case_links"),
          });
        },
      };

      return builder;
    },
  } as unknown as Supabase;

  return { supabase, orderedBy, claimInSizes, rpcCalls };
}

function makeBaseline(index: number): BaselineRow {
  return {
    sku_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    sku: `SKU-${String(index)}`,
    title: `Produto ${String(index)}`,
    weekday: 0,
    current_units_sold: 0,
    baseline_mean: 4,
    baseline_stddev: 0.5,
    sample_count: 8,
  };
}

describe("leituras de /diagnostico acima de 1.000 linhas (D-739)", () => {
  it("catálogo <= 1.000 para em uma chamada de get_sku_sales_baseline graças a count exact", async () => {
    const { supabase, rpcCalls } = fakeSupabase({
      baseline: [makeBaseline(1), makeBaseline(2)],
    });

    const res = await lerBaselineDoDiagnostico(supabase, ORG, AS_OF);

    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(2);
    expect(rpcCalls).toEqual(["get_sku_sales_baseline"]);
  });

  it("baseline > 1.000 SKUs lê todas as páginas com ordem estável por sku_id", async () => {
    const baseline = Array.from({ length: 1251 }, (_, i) => makeBaseline(i));
    const { supabase, orderedBy } = fakeSupabase({ baseline });

    const res = await lerBaselineDoDiagnostico(supabase, ORG, AS_OF);

    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1251);
    expect(res.data.at(-1)?.sku_id).toBe(makeBaseline(1250).sku_id);
    expect(orderedBy.get_sku_sales_baseline?.every((cols) => cols.join(",") === "sku_id")).toBe(true);
  });

  it("muitos candidatos paginam eventos e fatiamento `.in` de SAC em lotes de <= 200", async () => {
    const skus = Array.from({ length: 450 }, (_, i) => makeBaseline(i).sku_id);
    const ultimo = skus[449]!;
    const events = [
      ...Array.from({ length: 1050 }, (_, i) => ({
        sku_id: skus[i % 449]!,
        event_type: "listing.price.changed",
        occurred_at: "2026-10-19T10:00:00.000Z",
        marketplace: "ML",
      })),
      {
        sku_id: ultimo,
        event_type: "stock.depleted",
        occurred_at: "2026-10-19T12:00:00.000Z",
        marketplace: null,
      },
    ];
    const claims = [
      ...Array.from({ length: 1050 }, (_, i) => ({
        sku_id: skus[i % 449]!,
        support_case_id: `case-${String(i)}`,
      })),
      { sku_id: ultimo, support_case_id: "case-ultimo-1" },
      { sku_id: ultimo, support_case_id: "case-ultimo-2" },
    ];

    const { supabase, claimInSizes, orderedBy } = fakeSupabase({ events, claims });

    const res = await lerEvidenciasDoDiagnostico(supabase, ORG, AS_OF, skus);

    expect(res.eventsError).toBeNull();
    expect(res.claimsError).toBeNull();
    expect(res.eventsBySku.get(ultimo)?.map((e) => e.eventType)).toEqual(["stock.depleted"]);
    expect(res.openClaimsBySku.get(ultimo)).toEqual(new Set(["case-ultimo-1", "case-ultimo-2"]));
    expect(Math.max(...claimInSizes)).toBeLessThanOrEqual(DIAGNOSTICO_CHUNK);
    expect(claimInSizes.reduce((sum, size) => sum + size, 0)).toBe(450);
    expect(orderedBy.support_case_links?.every((cols) => cols.includes("id"))).toBe(true);
    expect(orderedBy.get_sku_correlated_events?.every((cols) => cols.length >= 3 && cols[0] === "sku_id")).toBe(true);
  });

  it("preços médios > 1.000 linhas paginam por (sku_id, marketplace) sem cortar os últimos", async () => {
    const skus = Array.from({ length: 600 }, (_, i) => makeBaseline(i).sku_id);
    const ultimo = skus[599]!;
    const prices = [
      ...Array.from({ length: 1050 }, (_, i) => ({
        sku_id: skus[i % 599]!,
        average_price: 20,
        marketplace: i % 2 === 0 ? "ML" : "SHOPEE",
      })),
      { sku_id: ultimo, average_price: 75.5, marketplace: "ML" },
    ];

    const { supabase, orderedBy } = fakeSupabase({ prices });

    const res = await lerPrecosMediosDoDiagnostico(supabase, ORG, AS_OF, skus);

    expect(res.error).toBeNull();
    expect(res.precoPorSku.get(ultimo)).toBe(75.5);
    expect(orderedBy.get_sku_average_prices?.every((cols) => cols.join(",") === "sku_id,marketplace")).toBe(true);
  });

  it("falha em lote de SAC descarta dados parciais e propaga claimsError", async () => {
    const skus = Array.from({ length: 250 }, (_, i) => makeBaseline(i).sku_id);
    const { supabase } = fakeSupabase({
      claims: [{ sku_id: skus[0]!, support_case_id: "c1" }],
      claimsFailOnSecondChunk: true,
    });

    const res = await lerEvidenciasDoDiagnostico(supabase, ORG, AS_OF, skus);

    expect(res.claimsError).toEqual({ message: "falha no lote 2 de SAC" });
    expect(res.openClaimsBySku.size).toBe(0);
  });
});
