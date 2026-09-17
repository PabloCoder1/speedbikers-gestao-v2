import { describe, expect, it } from "vitest";

import type { AdminClient } from "./admin-client.js";
import { readLastRelistFailureReason } from "./listing-relists.js";

const RELIST_ID = "cccccccc-0000-4000-8000-000000000001";
const OUTRA_OPERACAO = "cccccccc-0000-4000-8000-000000000002";

interface EventRow {
  relist_id: string;
  to_status: string;
  reason: string | null;
  occurred_at: string;
}

/**
 * Um PostgREST de mentira que APLICA o que a consulta pede — filtros de
 * igualdade, ordem e limite — sobre um histórico de verdade. Um fake que
 * devolvesse um motivo fixo aprovaria a consulta com a ordem invertida ou sem
 * filtro (achado R2 da revisão de D-364).
 */
function fakeClient(rows: EventRow[], error: { message: string } | null = null): { client: AdminClient; tables: string[] } {
  const tables: string[] = [];

  const client = {
    from: (table: string) => {
      tables.push(table);
      let result = [...rows];
      let selected = "";

      const builder = {
        select: (columns: string) => {
          selected = columns;

          return builder;
        },
        eq: (column: keyof EventRow, value: string) => {
          result = result.filter((row) => row[column] === value);

          return builder;
        },
        order: (column: keyof EventRow, options: { ascending: boolean }) => {
          result.sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (options.ascending ? 1 : -1));

          return builder;
        },
        limit: (count: number) => {
          result = result.slice(0, count);

          return builder;
        },
        maybeSingle: () => {
          if (error !== null) {
            return Promise.resolve({ data: null, error });
          }

          const row = result[0];

          return Promise.resolve({
            data: row === undefined ? null : Object.fromEntries(selected.split(",").map((key) => [key.trim(), row[key.trim() as keyof EventRow]])),
            error: null,
          });
        },
      };

      return builder;
    },
  } as unknown as AdminClient;

  return { client, tables };
}

function evento(overrides: Partial<EventRow>): EventRow {
  return {
    relist_id: RELIST_ID,
    to_status: "RELIST_FAILED",
    reason: "POST_RECUSADO",
    occurred_at: "2026-09-16T18:41:12.000000+00:00",
    ...overrides,
  };
}

describe("readLastRelistFailureReason (D-364)", () => {
  it("recusa antiga seguida de 5xx na retomada: a ÚLTIMA falha é POST_FALHOU", async () => {
    const { client, tables } = fakeClient([
      evento({ reason: "POST_RECUSADO", occurred_at: "2026-09-16T18:41:12.000000+00:00" }),
      evento({ to_status: "RELISTING", reason: "RETOMADA_APOS_RECUSA", occurred_at: "2026-09-17T10:00:00.000000+00:00" }),
      evento({ reason: "POST_FALHOU", occurred_at: "2026-09-17T10:00:05.000000+00:00" }),
    ]);

    expect(await readLastRelistFailureReason(client, RELIST_ID)).toEqual({ ok: true, reason: "POST_FALHOU" });
    expect(tables).toEqual(["listing_relist_events"]);
  });

  it("o evento de OUTRA operação nunca decide esta, nem sendo o mais recente", async () => {
    const { client } = fakeClient([
      evento({ reason: "POST_FALHOU", occurred_at: "2026-09-16T18:41:12.000000+00:00" }),
      evento({ relist_id: OUTRA_OPERACAO, reason: "POST_RECUSADO", occurred_at: "2026-09-17T10:00:00.000000+00:00" }),
    ]);

    expect(await readLastRelistFailureReason(client, RELIST_ID)).toEqual({ ok: true, reason: "POST_FALHOU" });
  });

  it("só a ENTRADA em RELIST_FAILED conta — a transição mais recente para outro estado não", async () => {
    const { client } = fakeClient([
      evento({ reason: "POST_RECUSADO", occurred_at: "2026-09-16T18:41:12.000000+00:00" }),
      evento({ to_status: "RELISTING", reason: "RETOMADA_APOS_RECUSA", occurred_at: "2026-09-17T10:00:00.000000+00:00" }),
    ]);

    expect(await readLastRelistFailureReason(client, RELIST_ID)).toEqual({ ok: true, reason: "POST_RECUSADO" });
  });

  it("sem evento de falha: reason null; erro do banco vira ok false com a mensagem", async () => {
    expect(await readLastRelistFailureReason(fakeClient([]).client, RELIST_ID)).toEqual({ ok: true, reason: null });
    expect(
      await readLastRelistFailureReason(fakeClient([evento({})], { message: "permission denied" }).client, RELIST_ID),
    ).toEqual({ ok: false, message: "permission denied" });
  });
});
