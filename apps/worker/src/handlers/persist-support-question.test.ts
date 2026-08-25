import {
  mapQuestionToSupportProjection,
  receivedQuestionSchema,
} from "@sb/mercado-livre";
import { describe, expect, it } from "vitest";

import type { PersistSupportQuestionContext } from "./persist-support-question.js";
import { persistSupportQuestion } from "./persist-support-question.js";

const CONTEXT: PersistSupportQuestionContext = {
  organizationId: "11111111-0000-4000-8000-000000000001",
  mlAccountId: "aaaaaaaa-0000-4000-8000-000000000001",
};
const OBSERVED_AT = new Date("2026-08-25T18:00:00.000Z");

const UNANSWERED = receivedQuestionSchema.parse({
  id: 11_436_370_259,
  seller_id: 419_059_118,
  item_id: "MLB1623490410",
  status: "UNANSWERED",
  text: "O produto ainda está disponível?",
  date_created: "2020-08-20T13:22:01.600-04:00",
  from: { id: 419_067_349 },
  answer: null,
});

const ANSWERED = receivedQuestionSchema.parse({
  ...UNANSWERED,
  status: "ANSWERED",
  last_updated: "2020-08-20T14:00:00.000-04:00",
  answer: {
    text: "Sim, está disponível.",
    status: "ACTIVE",
    date_created: "2020-08-20T14:00:00.000-04:00",
  },
});

type Row = Record<string, unknown>;

function matches(row: Row, filters: Row): boolean {
  return Object.entries(filters).every(([column, value]) => row[column] === value);
}

function selectChain(rows: () => Row[]) {
  const filters: Row = {};
  const chain = {
    eq(column: string, value: unknown) {
      filters[column] = value;
      return chain;
    },
    maybeSingle: () => {
      const found = rows().filter((row) => matches(row, filters));
      return Promise.resolve({ data: found[0] ?? null, error: null });
    },
  };

  return chain;
}

function deleteChain(rows: Row[]) {
  const filters: Row = {};
  const chain = {
    eq(column: string, value: unknown) {
      filters[column] = value;
      return chain;
    },
    then<TResult1 = { data: null; error: null }>(
      onFulfilled?: ((value: { data: null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    ): Promise<TResult1 | { data: null; error: null }> {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row !== undefined && matches(row, filters)) {
          rows.splice(index, 1);
        }
      }

      const result = { data: null, error: null } as const;
      return onFulfilled === undefined || onFulfilled === null
        ? Promise.resolve(result)
        : Promise.resolve(onFulfilled(result));
    },
  };

  return chain;
}

function updateSingleChain(rows: () => Row[], updates: Row) {
  const filters: Row = {};
  const chain = {
    eq(column: string, value: unknown) {
      filters[column] = value;
      return chain;
    },
    select: () => ({
      single: () => {
        const found = rows().filter((row) => matches(row, filters));
        const row = found[0];
        if (row === undefined || found.length !== 1) {
          return Promise.resolve({ data: null, error: { message: "case não encontrado" } });
        }

        Object.assign(row, updates);
        return Promise.resolve({ data: { id: row.id as string }, error: null });
      },
    }),
  };

  return chain;
}

function linkIdentity(row: Row): string {
  const supportCaseId = typeof row.support_case_id === "string" ? row.support_case_id : "missing-case";
  const listingId = row.listing_id;
  if (typeof listingId === "string") {
    return `${supportCaseId}:listing:${listingId}`;
  }

  const skuId = row.sku_id;
  if (typeof skuId === "string") {
    return `${supportCaseId}:sku:${skuId}`;
  }

  const entityKind = typeof row.external_entity_kind === "string" ? row.external_entity_kind : "missing-kind";
  const entityId = typeof row.external_entity_id === "string" ? row.external_entity_id : "missing-id";
  return `${supportCaseId}:external:${entityKind}:${entityId}`;
}

function statefulFakeDb() {
  const cases = new Map<string, Row>();
  const messages = new Map<string, Row>();
  const links: Row[] = [];
  const listings: Row[] = [];
  let caseSequence = 0;

  function caseIdentity(row: Row): string {
    return [row.organization_id, row.ml_account_id, row.channel, row.external_case_key].map(String).join(":");
  }

  const db = {
    from(table: string) {
      return {
        select: () => {
          if (table === "support_cases") {
            return selectChain(() => [...cases.values()]);
          }

          if (table === "listings") {
            return selectChain(() => listings);
          }

          throw new Error(`select inesperado em ${table}`);
        },
        upsert: (input: Row | Row[], options?: { ignoreDuplicates?: boolean }) => {
          const rows = Array.isArray(input) ? input : [input];

          if (table === "support_cases") {
            const row = rows[0];
            if (row === undefined) {
              throw new Error("upsert de case sem linha");
            }

            const key = caseIdentity(row);
            const previous = cases.get(key);
            if (previous === undefined || options?.ignoreDuplicates !== true) {
              cases.set(key, {
                ...previous,
                ...row,
                id: previous?.id ?? `case-${String(++caseSequence)}`,
              });
            }

            return Promise.resolve({ data: null, error: null });
          }

          if (table === "support_messages") {
            for (const row of rows) {
              const key = `${String(row.support_case_id)}:${String(row.external_message_key)}`;
              messages.set(key, { ...messages.get(key), ...row });
            }

            return Promise.resolve({ data: null, error: null });
          }

          throw new Error(`upsert inesperado em ${table}`);
        },
        update: (input: Row) => {
          if (table !== "support_cases") {
            throw new Error(`update inesperado em ${table}`);
          }

          return updateSingleChain(() => [...cases.values()], input);
        },
        insert: (input: Row) => {
          if (table !== "support_case_links") {
            throw new Error(`insert inesperado em ${table}`);
          }

          const key = linkIdentity(input);
          if (links.some((row) => linkIdentity(row) === key)) {
            return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
          }

          links.push({ ...input });
          return Promise.resolve({ data: null, error: null });
        },
        delete: () => {
          if (table !== "support_case_links") {
            throw new Error(`delete inesperado em ${table}`);
          }

          return deleteChain(links);
        },
      };
    },
  } as unknown as Parameters<typeof persistSupportQuestion>[0];

  return {
    db,
    cases,
    messages,
    links,
    addListing(row: { id: string; sku_id: string | null; item_id: string }) {
      listings.push({
        ...row,
        organization_id: CONTEXT.organizationId,
        ml_account_id: CONTEXT.mlAccountId,
      });
    },
  };
}

function project(question = UNANSWERED) {
  return mapQuestionToSupportProjection(question, OBSERVED_AT);
}

describe("persistSupportQuestion", () => {
  it("cria case, mensagem e fallback externo quando o anúncio ainda não existe localmente", async () => {
    const state = statefulFakeDb();
    const result = await persistSupportQuestion(state.db, CONTEXT, project());

    expect(result).toEqual({ supportCaseId: "case-1", messagesUpserted: 1, linkMode: "EXTERNAL" });
    expect(state.cases.size).toBe(1);
    expect(state.messages.size).toBe(1);
    expect(state.links).toEqual([
      expect.objectContaining({
        support_case_id: "case-1",
        external_entity_kind: "LISTING",
        external_entity_id: "MLB1623490410",
      }),
    ]);
  });

  it("rodar duas vezes produz um case, uma mensagem e um vínculo — idempotência", async () => {
    const state = statefulFakeDb();
    const projection = project();

    await persistSupportQuestion(state.db, CONTEXT, projection);
    await persistSupportQuestion(state.db, CONTEXT, projection);

    expect(state.cases.size).toBe(1);
    expect(state.messages.size).toBe(1);
    expect(state.links).toHaveLength(1);
  });

  it("atualiza estado remoto e acrescenta resposta sem sobrescrever triagem humana", async () => {
    const state = statefulFakeDb();
    await persistSupportQuestion(state.db, CONTEXT, project());

    const existing = [...state.cases.values()][0];
    if (existing === undefined) {
      throw new Error("fixture não criou case");
    }
    existing.internal_status = "EM_ATENDIMENTO";
    existing.priority = "ALTA";
    existing.assignee_id = "usuario-operador";
    existing.resolved_at = null;

    await persistSupportQuestion(state.db, CONTEXT, project(ANSWERED));

    const updated = [...state.cases.values()][0];
    expect(updated).toMatchObject({
      external_status: "ANSWERED",
      internal_status: "EM_ATENDIMENTO",
      priority: "ALTA",
      assignee_id: "usuario-operador",
      resolved_at: null,
    });
    expect(state.messages.size).toBe(2);
  });

  it("case que chega respondido na primeira observação nasce RESOLVIDO", async () => {
    const state = statefulFakeDb();
    await persistSupportQuestion(state.db, CONTEXT, project(ANSWERED));

    expect([...state.cases.values()][0]).toMatchObject({
      internal_status: "RESOLVIDO",
      resolved_at: "2020-08-20T18:00:00.000Z",
    });
    expect(state.messages.size).toBe(2);
  });

  it("troca o fallback externo por links tipados de anúncio e SKU quando o listing aparece", async () => {
    const state = statefulFakeDb();
    const projection = project();
    await persistSupportQuestion(state.db, CONTEXT, projection);

    state.addListing({
      id: "listing-1",
      sku_id: "sku-1",
      item_id: "MLB1623490410",
    });
    const result = await persistSupportQuestion(state.db, CONTEXT, projection);

    expect(result.linkMode).toBe("TYPED");
    expect(state.links).toHaveLength(2);
    expect(state.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ listing_id: "listing-1", link_source: "REMOTE" }),
        expect.objectContaining({ sku_id: "sku-1", link_source: "LISTING_DERIVED" }),
      ]),
    );
    expect(state.links.some((row) => row.external_entity_kind === "LISTING")).toBe(false);
  });
});
