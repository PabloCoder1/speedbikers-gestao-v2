import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { RelistMeasurementDeps, RelistMeasurementOperation } from "./relist-measurement.js";
import { ensureRelistMeasurement } from "./relist-measurement.js";

const OPERATION: RelistMeasurementOperation = {
  id: "cccccccc-0000-4000-8000-000000000001",
  organization_id: "11111111-0000-4000-8000-000000000001",
  ml_account_id: "aaaaaaaa-0000-4000-8000-000000000001",
  parent_item_id: "MLB910000001",
  child_item_id: "MLB910000777",
  requested_by: "bbbbbbbb-0000-4000-8000-000000000002",
};

const SKU_ID = "dddddddd-0000-4000-8000-000000000003";
const NOW = new Date("2026-08-31T15:00:00.000Z");

interface FakeDbOptions {
  childSkuId?: string | null;
  existingActionId?: string;
  existingDecision?: boolean;
  actionInsertError?: { code?: string; message: string };
}

function fakeDb(options: FakeDbOptions = {}): {
  db: RelistMeasurementDeps["db"];
  actionInserts: Record<string, unknown>[];
  decisionInserts: Record<string, unknown>[];
  snapshotCalls: Record<string, unknown>[];
} {
  const actionInserts: Record<string, unknown>[] = [];
  const decisionInserts: Record<string, unknown>[] = [];
  const snapshotCalls: Record<string, unknown>[] = [];

  function selectChain(result: unknown): unknown {
    const self = {
      eq: () => self,
      is: () => self,
      maybeSingle: () => Promise.resolve({ data: result, error: null }),
    };

    return self;
  }

  const db = {
    from: (table: string) => ({
      select: () => {
        if (table === "sku_listing_links") {
          return selectChain(
            options.childSkuId === null ? null : { sku_id: options.childSkuId ?? SKU_ID },
          );
        }

        if (table === "actions") {
          return selectChain(
            options.existingActionId === undefined ? null : { id: options.existingActionId },
          );
        }

        if (table === "action_decisions") {
          return selectChain(options.existingDecision === true ? { id: "dec-1" } : null);
        }

        return selectChain(null);
      },
      insert: (row: Record<string, unknown>) => {
        if (table === "actions") {
          actionInserts.push(row);

          return {
            select: () => ({
              single: () =>
                Promise.resolve(
                  options.actionInsertError !== undefined
                    ? { data: null, error: options.actionInsertError }
                    : { data: { id: "action-1" }, error: null },
                ),
            }),
          };
        }

        decisionInserts.push(row);

        return Promise.resolve({ error: null });
      },
    }),
    rpc: (_name: string, args: Record<string, unknown>) => {
      snapshotCalls.push(args);

      return Promise.resolve({ data: { as_of: "2026-08-31", units_sold_7d: 12 }, error: null });
    },
  } as unknown as RelistMeasurementDeps["db"];

  return { db, actionInserts, decisionInserts, snapshotCalls };
}

function run(db: RelistMeasurementDeps["db"], operation = OPERATION) {
  return ensureRelistMeasurement({ db, now: () => NOW }, createLogger({}, { sink: () => undefined }), operation);
}

describe("ensureRelistMeasurement (D-164)", () => {
  it("cria a ação RESOLVIDA (registro, não pendência) e a decisão atribuída ao humano que pediu, com baseline da hora", async () => {
    const { db, actionInserts, decisionInserts, snapshotCalls } = fakeDb();

    const result = await run(db);

    expect(result).toEqual({ ok: true });
    expect(actionInserts[0]).toMatchObject({
      kind: "republicacao",
      status: "resolvido",
      sku_id: SKU_ID,
      mlb_id: OPERATION.child_item_id,
      dedup_key: `republicacao:${OPERATION.id}`,
    });
    // Linguagem de honestidade: "após", nunca causal.
    expect(String(actionInserts[0]?.recommendation)).toContain("após a republicação");
    expect(String(actionInserts[0]?.recommendation)).not.toContain("por causa");

    expect(decisionInserts[0]).toMatchObject({
      action_id: "action-1",
      created_by: OPERATION.requested_by,
    });
    expect(decisionInserts[0]?.baseline_snapshot).toMatchObject({ units_sold_7d: 12 });
    expect(snapshotCalls[0]).toMatchObject({ p_sku_id: SKU_ID, p_as_of: "2026-08-31" });
  });

  it("idempotente: ação e decisão existentes ⇒ nada é inserido e nada é recalculado", async () => {
    const { db, actionInserts, decisionInserts, snapshotCalls } = fakeDb({
      existingActionId: "action-1",
      existingDecision: true,
    });

    const result = await run(db);

    expect(result).toEqual({ ok: true });
    expect(actionInserts).toHaveLength(0);
    expect(decisionInserts).toHaveLength(0);
    expect(snapshotCalls).toHaveLength(0);
  });

  it("filho sem SKU (pai de variações aguardando vinculação humana): ação sem SKU e baseline VAZIO — nunca inventado", async () => {
    const { db, actionInserts, decisionInserts, snapshotCalls } = fakeDb({ childSkuId: null });

    const result = await run(db);

    expect(result).toEqual({ ok: true });
    expect(actionInserts[0]?.sku_id).toBeNull();
    expect(decisionInserts[0]?.baseline_snapshot).toEqual({});
    expect(snapshotCalls).toHaveLength(0);
  });

  it("corrida na criação da ação (23505): relê e segue — mas releitura vazia é falha, nunca decisão órfã", async () => {
    const { db } = fakeDb({ actionInsertError: { code: "23505", message: "duplicate" } });

    // O fake devolve `null` na releitura (existingActionId ausente) — o
    // caminho honesto é falhar para o retry reler o mundo.
    const result = await run(db);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("corrida");
  });
});
