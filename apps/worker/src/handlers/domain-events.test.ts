import type { DomainEventDraft } from "@sb/domain";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { RecordDomainEventsContext } from "./domain-events.js";
import { recordDomainEvents } from "./domain-events.js";

const CONTEXT: RecordDomainEventsContext = {
  organizationId: "11111111-0000-4000-8000-000000000001",
  mlAccountId: "aaaaaaaa-0000-4000-8000-000000000001",
};

function draft(entityId: string): DomainEventDraft {
  return {
    eventType: "order.cancelled",
    entityType: "order",
    entityId,
    before: { status: "paid" },
    after: { status: "cancelled" },
    severity: "importante",
    source: "sync",
    dedupKey: `order.cancelled:${entityId}:cancelled`,
    occurredAt: new Date("2026-08-21T15:00:00.000Z"),
  };
}

function fakeDb(errorForDedupKey?: { dedupKey: string; code: string; message: string }): {
  db: Parameters<typeof recordDomainEvents>[0];
  inserted: unknown[];
} {
  const inserted: unknown[] = [];

  const db = {
    from: () => ({
      // `upsert` desde D-092: a gravação passou a usar ON CONFLICT DO NOTHING
      // para não transformar cada conflito esperado de `dedup_key` numa linha
      // ERROR no log do Postgres.
      upsert: (row: { dedup_key: string }) => {
        inserted.push(row);

        if (row.dedup_key === errorForDedupKey?.dedupKey) {
          return Promise.resolve({
            data: null,
            error: { code: errorForDedupKey.code, message: errorForDedupKey.message },
          });
        }

        return Promise.resolve({ data: null, error: null });
      },
    }),
  } as unknown as Parameters<typeof recordDomainEvents>[0];

  return { db, inserted };
}

describe("recordDomainEvents", () => {
  it("não faz nada com uma lista vazia de rascunhos", async () => {
    const { db, inserted } = fakeDb();

    await recordDomainEvents(db, CONTEXT, [], createLogger({}, { sink: () => undefined }));

    expect(inserted).toHaveLength(0);
  });

  it("grava um evento por rascunho, com organization_id/ml_account_id do contexto", async () => {
    const { db, inserted } = fakeDb();

    await recordDomainEvents(db, CONTEXT, [draft("1"), draft("2")], createLogger({}, { sink: () => undefined }));

    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({
      organization_id: CONTEXT.organizationId,
      ml_account_id: CONTEXT.mlAccountId,
      entity_id: "1",
    });
  });

  it("conflito de dedup_key (23505) num rascunho não impede os demais de serem gravados", async () => {
    const { db, inserted } = fakeDb({ dedupKey: "order.cancelled:1:cancelled", code: "23505", message: "dup" });
    const lines: string[] = [];

    await recordDomainEvents(
      db,
      CONTEXT,
      [draft("1"), draft("2")],
      createLogger({}, { sink: (line) => lines.push(line) }),
    );

    expect(inserted).toHaveLength(2);
    expect(lines.join()).not.toContain("domain_event_not_recorded");
  });

  it("uma falha real (não-dedup) é logada, sem lançar", async () => {
    const { db } = fakeDb({ dedupKey: "order.cancelled:1:cancelled", code: "42P01", message: "boom" });
    const lines: string[] = [];

    await expect(
      recordDomainEvents(db, CONTEXT, [draft("1")], createLogger({}, { sink: (line) => lines.push(line) })),
    ).resolves.toBeUndefined();

    expect(lines.join()).toContain("domain_event_not_recorded");
  });
});
