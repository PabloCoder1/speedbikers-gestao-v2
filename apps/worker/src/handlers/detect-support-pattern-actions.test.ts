import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { DetectSupportPatternActionsDeps } from "./detect-support-pattern-actions.js";
import { createDetectSupportPatternActionsHandler } from "./detect-support-pattern-actions.js";

const ORG = "11111111-0000-4000-8000-000000000001";
const SKU_A = "aaaaaaaa-0000-4000-8000-00000000000a";

const logger = createLogger({}, { sink: () => undefined });
const envelope = { jobId: "j1" } as never;

function skuLink(caseId: string, options: { mediation?: boolean } = {}) {
  return {
    support_case_id: caseId,
    sku_id: SKU_A,
    skus: { sku: "5821", title: "Baú 45L" },
    support_cases: { internal_status: "NOVO", channel: "CLAIM", is_mediation: options.mediation ?? false },
  };
}

function fakeDb(options: {
  skuLinks?: unknown[];
  orderLinks?: unknown[];
  skuLinksFail?: boolean;
}): { db: DetectSupportPatternActionsDeps["db"]; upserted: Record<string, unknown>[][] } {
  const upserted: Record<string, unknown>[][] = [];

  const db = {
    from: (table: string) => {
      if (table === "support_case_links") {
        const chain = {
          calls: 0,
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          // A 1ª consulta (links de SKU) termina em .neq; a 2ª (pedidos)
          // termina em .not.
          neq: () =>
            Promise.resolve(
              options.skuLinksFail === true
                ? { data: null, error: { message: "boom" } }
                : { data: options.skuLinks ?? [], error: null },
            ),
          not: (column: string) =>
            column === "sku_id"
              ? chain
              : Promise.resolve({ data: options.orderLinks ?? [], error: null }),
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

  return { db, upserted };
}

async function run(options: Parameters<typeof fakeDb>[0]) {
  const { db, upserted } = fakeDb(options);
  const handler = createDetectSupportPatternActionsHandler({ db });

  const outcome = await handler(envelope, { payload: { organizationId: ORG }, logger });

  return { outcome, upserted };
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
});
