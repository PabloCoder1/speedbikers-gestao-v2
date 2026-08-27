import { describe, expect, it } from "vitest";

import { claimSchema } from "./claim-schema.js";
import { mapClaimToSupportProjection } from "./claim-support-projection.js";
import type { PersistSupportClaimContext } from "./persist-support-claim.js";
import { persistSupportClaim } from "./persist-support-claim.js";

const CONTEXT: PersistSupportClaimContext = {
  organizationId: "11111111-0000-4000-8000-000000000001",
  mlAccountId: "aaaaaaaa-0000-4000-8000-000000000001",
  source: "WEBHOOK",
};

const OPEN_CLAIM = {
  id: 5256749420,
  resource: "order",
  resource_id: 2000007819609432,
  status: "opened",
  type: "mediations",
  stage: "claim",
  players: [{ role: "complainant", type: "buyer", user_id: 1325224382, available_actions: [] }],
  date_created: "2024-03-14T08:28:44.000-04:00",
  last_updated: "2024-03-14T08:28:44.000-04:00",
  related_entities: [],
};

type Row = Record<string, unknown>;

function matches(row: Row, filters: Row): boolean {
  return Object.entries(filters).every(([column, value]) => row[column] === value);
}

/** Fake stateful mínimo: só as tabelas que `persistSupportClaim` toca. */
function fakeDb(options: { orders?: number[]; caseWriteError?: string } = {}) {
  const cases = new Map<string, Row>();
  const links: Row[] = [];
  const messages: Row[] = [];
  const deadlines: Row[] = [];
  const notFilters: { column: string; value: string }[] = [];
  const orders = (options.orders ?? []).map((id) => ({ id, organization_id: CONTEXT.organizationId }));
  const rpcCalls: { fn: string; args: Row }[] = [];
  let sequence = 0;

  const identity = (row: Row): string =>
    [row.organization_id, row.ml_account_id, row.channel, row.external_case_key].map(String).join(":");

  function selectChain(rows: () => Row[]) {
    const filters: Row = {};
    const chain = {
      eq(column: string, value: unknown) {
        filters[column] = value;
        return chain;
      },
      maybeSingle: () =>
        Promise.resolve({ data: rows().find((row) => matches(row, filters)) ?? null, error: null }),
    };
    return chain;
  }

  const db = {
    rpc(fn: string, args: Row) {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: true, error: null });
    },
    from(table: string) {
      return {
        select: () => {
          if (table === "orders") {
            return selectChain(() => orders);
          }
          throw new Error(`select inesperado em ${table}`);
        },
        upsert: (input: Row | Row[], options2?: { ignoreDuplicates?: boolean }) => {
          if (table === "support_messages" || table === "support_case_deadlines") {
            const target = table === "support_messages" ? messages : deadlines;
            for (const row of Array.isArray(input) ? input : [input]) {
              target.push(row);
            }
            return Promise.resolve({ data: null, error: null });
          }

          const key = identity(input as Row);
          const previous = cases.get(key);
          if (previous === undefined || options2?.ignoreDuplicates !== true) {
            cases.set(key, { ...previous, ...(input as Row), id: previous?.id ?? `case-${String(++sequence)}` });
          }
          return Promise.resolve({ data: null, error: null });
        },
        update: (updates: Row) => {
          const filters: Row = {};
          const chain = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return chain;
            },
            /** `support_case_deadlines`: cancelamento dos prazos que sumiram. */
            not(column: string, _operator: string, value: unknown) {
              notFilters.push({ column, value: String(value) });
              return chain;
            },
            /** A cadeia de cancelamento é aguardada direto, sem `.select()`. */
            then<T>(onFulfilled?: ((value: { data: null; error: null }) => T) | null) {
              for (const row of deadlines) {
                if (!matches(row, filters)) {
                  continue;
                }
                const excluded = notFilters.some((entry) => {
                  const raw = row[entry.column];
                  return typeof raw === "string" && entry.value.includes(raw);
                });
                if (!excluded) {
                  Object.assign(row, updates);
                }
              }
              const result = { data: null, error: null } as const;
              return onFulfilled == null ? Promise.resolve(result) : Promise.resolve(onFulfilled(result));
            },
            select: () => ({
              single: () => {
                if (options.caseWriteError !== undefined) {
                  return Promise.resolve({ data: null, error: { message: options.caseWriteError } });
                }
                const row = [...cases.values()].find((candidate) => matches(candidate, filters));
                if (row === undefined) {
                  return Promise.resolve({ data: null, error: { message: "case não encontrado" } });
                }
                Object.assign(row, updates);
                return Promise.resolve({ data: { id: row.id as string }, error: null });
              },
            }),
          };
          return chain;
        },
        insert: (row: Row) => {
          links.push(row);
          return Promise.resolve({ data: null, error: null });
        },
        delete: () => {
          const filters: Row = {};
          const chain = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return chain;
            },
            then<T>(onFulfilled?: ((value: { data: null; error: null }) => T) | null) {
              for (let index = links.length - 1; index >= 0; index -= 1) {
                const row = links[index];
                if (row !== undefined && matches(row, filters)) {
                  links.splice(index, 1);
                }
              }
              const result = { data: null, error: null } as const;
              return onFulfilled == null ? Promise.resolve(result) : Promise.resolve(onFulfilled(result));
            },
          };
          return chain;
        },
      };
    },
  };

  return { db, cases, links, messages, deadlines, rpcCalls };
}

function project(overrides: Record<string, unknown> = {}) {
  const projection = mapClaimToSupportProjection(claimSchema.parse({ ...OPEN_CLAIM, ...overrides }));
  if (projection === null) {
    throw new Error("fixture do teste deveria ser projetável");
  }
  return projection;
}

describe("persistSupportClaim", () => {
  it("cria o case com a identidade e as facetas do claim", async () => {
    const fake = fakeDb();

    const result = await persistSupportClaim(fake.db as never, CONTEXT, project({ stage: "dispute" }));

    const stored = [...fake.cases.values()][0];
    expect(result.supportCaseId).toBe("case-1");
    expect(stored?.channel).toBe("CLAIM");
    expect(stored?.external_case_key).toBe("claim:5256749420");
    expect(stored?.is_mediation).toBe(true);
    expect(stored?.last_activity_at).toBe("2024-03-14T08:28:44.000-04:00");
  });

  it("re-ingestão NÃO sobrescreve triagem humana", async () => {
    const fake = fakeDb();
    await persistSupportClaim(fake.db as never, CONTEXT, project());

    const stored = [...fake.cases.values()][0];
    // Simula a triagem de D-094 acontecendo entre as duas ingestões.
    Object.assign(stored ?? {}, { internal_status: "EM_ATENDIMENTO", assignee_id: "user-1", priority: "NORMAL" });

    await persistSupportClaim(fake.db as never, CONTEXT, project({ status: "closed" }));

    expect(stored?.internal_status).toBe("EM_ATENDIMENTO");
    expect(stored?.assignee_id).toBe("user-1");
    expect(stored?.priority).toBe("NORMAL");
    // ...mas a projeção remota ACOMPANHA.
    expect(stored?.external_status).toBe("closed");
  });

  it("reprocessar o mesmo claim não cria um segundo case", async () => {
    const fake = fakeDb();

    const first = await persistSupportClaim(fake.db as never, CONTEXT, project());
    const second = await persistSupportClaim(fake.db as never, CONTEXT, project());

    expect(first.supportCaseId).toBe(second.supportCaseId);
    expect(fake.cases.size).toBe(1);
  });

  it("pede a transição automática de D-102 pela RPC guardada", async () => {
    const fake = fakeDb();

    const result = await persistSupportClaim(fake.db as never, CONTEXT, project({ status: "closed" }));

    const call = fake.rpcCalls[0];
    expect(call?.fn).toBe("apply_support_remote_transition");
    expect(call?.args.p_new_status).toBe("RESOLVIDO");
    expect(call?.args.p_expected_statuses).toEqual(["NOVO"]);
    expect(call?.args.p_source).toBe("WEBHOOK");
    expect(result.transitionApplied).toBe(true);
  });

  it("vincula o pedido de forma tipada quando ele já existe", async () => {
    const fake = fakeDb({ orders: [2000007819609432] });

    const result = await persistSupportClaim(fake.db as never, CONTEXT, project());

    expect(result.linkMode).toBe("TYPED");
    expect(fake.links[0]?.order_id).toBe(2000007819609432);
  });

  it("pedido ainda não sincronizado vira vínculo EXTERNO, não erro de FK", async () => {
    // `support_case_links.order_id` tem FK real; sem o fallback, um claim de
    // pedido fora da janela de backfill derrubaria a ingestão inteira.
    const fake = fakeDb({ orders: [] });

    const result = await persistSupportClaim(fake.db as never, CONTEXT, project());

    expect(result.linkMode).toBe("EXTERNAL");
    expect(fake.links[0]?.external_entity_kind).toBe("ORDER");
    expect(fake.links[0]?.external_entity_id).toBe("2000007819609432");
    expect(fake.links[0]?.order_id).toBeUndefined();
  });

  it("o fallback externo é promovido a tipado quando o pedido chega", async () => {
    const fake = fakeDb({ orders: [] });
    await persistSupportClaim(fake.db as never, CONTEXT, project());
    expect(fake.links).toHaveLength(1);

    // O backfill trouxe o pedido; a próxima notificação reprocessa.
    const comPedido = fakeDb({ orders: [2000007819609432] });
    await persistSupportClaim(comPedido.db as never, CONTEXT, project());

    expect(comPedido.links).toHaveLength(1);
    expect(comPedido.links[0]?.order_id).toBe(2000007819609432);
  });

  it("claim que não é sobre pedido não cria vínculo nenhum", async () => {
    const fake = fakeDb();

    const result = await persistSupportClaim(fake.db as never, CONTEXT, project({ resource: "shipment" }));

    expect(result.linkMode).toBe("NONE");
    expect(fake.links).toHaveLength(0);
  });

  it("falha ao gravar o case propaga, nunca vira sucesso silencioso", async () => {
    const fake = fakeDb({ caseWriteError: "conexão perdida" });

    await expect(persistSupportClaim(fake.db as never, CONTEXT, project())).rejects.toThrow(/conexão perdida/);
  });
});
