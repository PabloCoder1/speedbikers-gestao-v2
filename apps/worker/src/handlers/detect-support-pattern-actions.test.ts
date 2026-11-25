import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { DetectSupportPatternActionsDeps } from "./detect-support-pattern-actions.js";
import { createDetectSupportPatternActionsHandler } from "./detect-support-pattern-actions.js";

const ORG = "11111111-0000-4000-8000-000000000001";
const SKU_A = "aaaaaaaa-0000-4000-8000-00000000000a";

const logger = createLogger({}, { sink: () => undefined });
const envelope = { jobId: "j1", organizationId: ORG } as never;

function skuLink(caseId: string, options: { mediation?: boolean; skuId?: string } = {}) {
  return {
    support_case_id: caseId,
    sku_id: options.skuId ?? SKU_A,
    skus: { sku: "5821", title: "Baú 45L" },
    support_cases: { internal_status: "NOVO", channel: "CLAIM", is_mediation: options.mediation ?? false },
  };
}

/** `max_rows` do PostgREST (`supabase/config.toml`): acima disso a resposta volta cortada, sem erro. */
const POSTGREST_CAP = 1000;

interface OrderLinkRow {
  support_case_id: string;
  orders: { total_amount: number | null } | null;
}

function fakeDb(options: {
  skuLinks?: unknown[];
  orderLinks?: OrderLinkRow[];
  skuLinksFail?: boolean;
  orderLinksFail?: boolean;
}): {
  db: DetectSupportPatternActionsDeps["db"];
  upserted: Record<string, unknown>[][];
  inSizes: number[];
  orderedBy: string[][];
} {
  const upserted: Record<string, unknown>[][] = [];
  const inSizes: number[] = [];
  const orderedBy: string[][] = [];

  const db = {
    from: (table: string) => {
      if (table === "support_case_links") {
        // Consulta encadeável e "awaitable" como o builder do PostgREST: a
        // 1ª (links de SKU) filtra `support_cases.channel`; a 2ª (pedidos)
        // filtra `order_id` não nulo e recebe `.in` com os cases.
        let kind: "sku" | "order" = "sku";
        let ids: Set<string> | null = null;
        let from = 0;
        let to = Number.POSITIVE_INFINITY;
        const order: string[] = [];

        const chain = {
          select: () => chain,
          eq: () => chain,
          neq: () => chain,
          in: (_column: string, values: string[]) => {
            inSizes.push(values.length);
            ids = new Set(values);

            return chain;
          },
          not: (column: string) => {
            if (column === "order_id") kind = "order";

            return chain;
          },
          order: (column: string) => {
            order.push(column);

            return chain;
          },
          range: (start: number, end: number) => {
            from = start;
            to = end;

            return chain;
          },
          then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
            orderedBy.push([...order]);

            const fails = kind === "sku" ? options.skuLinksFail === true : options.orderLinksFail === true;

            if (fails) {
              return Promise.resolve({ data: null, error: { message: "boom" } }).then(resolve, reject);
            }

            const all =
              kind === "sku"
                ? (options.skuLinks ?? [])
                : (options.orderLinks ?? []).filter((row) => ids === null || ids.has(row.support_case_id));
            const end = Math.min(to + 1, from + POSTGREST_CAP);

            return Promise.resolve({ data: all.slice(from, end), error: null }).then(resolve, reject);
          },
        };

        return chain;
      }

      if (table === "actions") {
        return {
          upsert: (rows: Record<string, unknown>[]) => {
            upserted.push(rows);

            return Promise.resolve({ error: null });
          },
        };
      }

      throw new Error(`tabela inesperada: ${table}`);
    },
  } as unknown as DetectSupportPatternActionsDeps["db"];

  return { db, upserted, inSizes, orderedBy };
}

async function run(options: Parameters<typeof fakeDb>[0] & { payload?: unknown }) {
  const { db, upserted, inSizes, orderedBy } = fakeDb(options);
  const handler = createDetectSupportPatternActionsHandler({ db });

  const outcome = await handler(envelope, { payload: options.payload ?? { organizationId: ORG }, logger });

  return { outcome, upserted, inSizes, orderedBy };
}

describe("detect-support-pattern-actions (D-116)", () => {
  it("3 claims abertos no mesmo SKU viram UMA ação agregada com dinheiro em risco real", async () => {
    const { outcome, upserted } = await run({
      skuLinks: [skuLink("c1"), skuLink("c2"), skuLink("c3")],
      orderLinks: [
        { support_case_id: "c1", orders: { total_amount: 100 } },
        { support_case_id: "c2", orders: { total_amount: 250.5 } },
      ],
    });

    expect(outcome).toEqual({ status: "done", processed: 1 });

    const action = upserted[0]?.[0];

    expect(action?.kind).toBe("reclamacoes_recorrentes");
    expect(action?.sku_id).toBe(SKU_A);
    expect(action?.estimated_impact_brl).toBe(350.5);
    expect(action?.severity).toBe("media");
    expect(action?.dedup_key).toBe(`support_pattern:claims:${SKU_A}`);
  });

  it("mediação envolvida sobe a severidade para alta", async () => {
    const { upserted } = await run({
      skuLinks: [skuLink("c1", { mediation: true }), skuLink("c2"), skuLink("c3")],
    });

    expect(upserted[0]?.[0]?.severity).toBe("alta");
  });

  it("abaixo do limiar: nenhuma ação — atendimento individual não é padrão", async () => {
    const { outcome, upserted } = await run({ skuLinks: [skuLink("c1"), skuLink("c2")] });

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(upserted).toHaveLength(0);
  });

  it("o mesmo case vinculado duas vezes ao SKU conta UMA vez", async () => {
    // Dois links (ex.: re-ingestão criou vínculo tipado e externo) não podem
    // inflar a contagem e fabricar um padrão que não existe.
    const { outcome } = await run({ skuLinks: [skuLink("c1"), skuLink("c1"), skuLink("c2")] });

    expect(outcome).toEqual({ status: "done", processed: 0 });
  });

  it("falha na leitura é retryable, nunca 'done, 0 padrões'", async () => {
    const { outcome } = await run({ skuLinksFail: true });

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("falha na leitura dos pedidos vinculados é retryable", async () => {
    const { outcome, upserted } = await run({
      skuLinks: [skuLink("c1"), skuLink("c2"), skuLink("c3")],
      orderLinksFail: true,
    });

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(upserted).toHaveLength(0);
  });

  const makeFiller = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      skuLink(`f${String(index)}`, { skuId: `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, "0")}` }),
    );

  it("D-738: mais de 1.000 vínculos abertos — o padrão no fim da lista não some no corte do PostgREST", async () => {
    // 1.197 claims isolados (um por SKU, abaixo do limiar) antes dos três do
    // SKU_A: sem paginação, a resposta parava nos 1.000 primeiros e o padrão
    // real desaparecia sem erro.
    const filler = makeFiller(1197);
    const { outcome, upserted, orderedBy } = await run({
      skuLinks: [...filler, skuLink("c1"), skuLink("c2"), skuLink("c3")],
      orderLinks: [{ support_case_id: "c3", orders: { total_amount: 80 } }],
    });

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(upserted[0]?.[0]).toMatchObject({ sku_id: SKU_A, estimated_impact_brl: 80 });
    // Paginação só é segura com ordem estável e única.
    expect(orderedBy.every((columns) => columns.includes("id"))).toBe(true);
  });

  it("D-738: os cases vão ao `.in` em lotes de até 200 — a URL não cresce com o volume", async () => {
    const filler = makeFiller(1197);
    const { inSizes, upserted } = await run({
      skuLinks: [...filler, skuLink("c1"), skuLink("c2"), skuLink("c3")],
      orderLinks: [
        { support_case_id: "c1", orders: { total_amount: 10 } },
        { support_case_id: "c3", orders: { total_amount: 20 } },
      ],
    });

    expect(inSizes.length).toBeGreaterThan(1);
    expect(Math.max(...inSizes)).toBeLessThanOrEqual(200);
    expect(inSizes.reduce((sum, size) => sum + size, 0)).toBe(1200);
    expect(upserted[0]?.[0]?.estimated_impact_brl).toBe(30);
  });

  it("D-814: recusa divergência entre organizationId do payload e do envelope e fatia actions.upsert em lotes de até 500", async () => {
    const outraOrg = "22222222-0000-4000-8000-000000000002";
    const mismatch = await run({ payload: { organizationId: outraOrg }, skuLinks: [skuLink("c1"), skuLink("c2"), skuLink("c3")] });

    expect(mismatch.outcome).toMatchObject({ status: "failed", retryable: false });
    expect(mismatch.upserted).toHaveLength(0);

    const manyLinks = Array.from({ length: 505 }, (_, i) => {
      const skuId = `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;

      return [0, 1, 2].map((k) => ({
        support_case_id: `case-${String(i)}-${String(k)}`,
        sku_id: skuId,
        skus: { sku: `SKU-${String(i)}`, title: `Item ${String(i)}` },
        support_cases: { internal_status: "NOVO", channel: "CLAIM", is_mediation: false },
      }));
    }).flat();

    const batched = await run({ skuLinks: manyLinks, orderLinks: [] });

    expect(batched.outcome).toEqual({ status: "done", processed: 505 });
    expect(batched.upserted).toHaveLength(2);
    expect(batched.upserted.every((batch) => batch.length <= 500)).toBe(true);
  });
});
