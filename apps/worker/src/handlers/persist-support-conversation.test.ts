import { mapPackMessagesToSupportProjection, packMessagesPageSchema } from "@sb/mercado-livre";
import type { SupportConversationReference } from "@sb/mercado-livre";
import { describe, expect, it } from "vitest";

import type { PersistSupportConversationContext } from "./persist-support-conversation.js";
import { persistSupportConversation } from "./persist-support-conversation.js";

const CONTEXT: PersistSupportConversationContext = {
  organizationId: "11111111-0000-4000-8000-000000000001",
  mlAccountId: "aaaaaaaa-0000-4000-8000-000000000001",
  source: "RECONCILIATION",
};
const OBSERVED_AT = new Date("2026-08-26T19:00:00.000Z");
const SELLER_ID = 419_059_118;
const PACK_REFERENCE: SupportConversationReference = {
  kind: "PACK",
  id: "2000000089077943",
  sellerId: SELLER_ID,
};

type Row = Record<string, unknown>;

function conversationPage(messages: Row[] = [buyerMessage("m1")]) {
  return packMessagesPageSchema.parse({
    conversation_status: {
      path: "/packs/2000000089077943/seller/419059118",
      status: "active",
      status_date: "2026-08-26T18:00:00.000Z",
    },
    messages,
  });
}

function buyerMessage(id: string): Row {
  return {
    id,
    from: { user_id: 777 },
    to: { user_id: SELLER_ID },
    status: "available",
    text: "quando chega?",
    message_date: { created: "2026-08-26T18:00:00.000Z" },
    message_resources: [{ id: "2000000089077943", name: "packs" }],
  };
}

function projection(reference: SupportConversationReference, messages?: Row[]) {
  return mapPackMessagesToSupportProjection(reference, conversationPage(messages), OBSERVED_AT, 2);
}

function matches(row: Row, filters: Row): boolean {
  return Object.entries(filters).every(([column, value]) => row[column] === value);
}

/**
 * Fake do PostgREST reduzido ao que esta porta usa. `orders` responde por
 * `await` direto (lista), não por `maybeSingle` — daí o `then`.
 */
function fakeDb(options: { orders?: Row[]; ordersError?: { message: string } } = {}) {
  const cases = new Map<string, Row>();
  const messages = new Map<string, Row>();
  const links: Row[] = [];
  const orders = options.orders ?? [];
  let caseSequence = 0;

  function caseIdentity(row: Row): string {
    return [row.organization_id, row.ml_account_id, row.channel, row.external_case_key]
      .map(String)
      .join(":");
  }

  function listChain(rows: Row[], error: { message: string } | null) {
    const filters: Row = {};
    const chain = {
      eq(column: string, value: unknown) {
        filters[column] = value;
        return chain;
      },
      then<T>(onFulfilled?: ((value: { data: Row[]; error: unknown }) => T) | null): Promise<T> {
        const result = {
          data: error === null ? rows.filter((row) => matches(row, filters)) : [],
          error,
        };

        return Promise.resolve(onFulfilled ? onFulfilled(result) : (result as unknown as T));
      },
    };

    return chain;
  }

  function updateChain(rows: () => Row[], updates: Row) {
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

          if (row === undefined) {
            return Promise.resolve({ data: null, error: { message: "case não encontrado" } });
          }

          Object.assign(row, updates);
          return Promise.resolve({ data: { id: row.id as string }, error: null });
        },
      }),
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
      then<T>(onFulfilled?: ((value: { data: null; error: null }) => T) | null): Promise<T> {
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          const row = rows[index];

          if (row !== undefined && matches(row, filters)) {
            rows.splice(index, 1);
          }
        }

        const result = { data: null, error: null } as const;
        return Promise.resolve(onFulfilled ? onFulfilled(result) : (result as unknown as T));
      },
    };

    return chain;
  }

  const rpcCalls: { fn: string; args: Row }[] = [];

  const db = {
    rpc(fn: string, args: Row) {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: true, error: null });
    },
    from(table: string) {
      return {
        select: () => {
          if (table === "orders") {
            return listChain(orders, options.ordersError ?? null);
          }

          throw new Error(`select inesperado em ${table}`);
        },
        upsert: (input: Row | Row[], upsertOptions?: { ignoreDuplicates?: boolean }) => {
          const rows = Array.isArray(input) ? input : [input];

          if (table === "support_cases") {
            const row = rows[0];

            if (row === undefined) {
              throw new Error("upsert de case sem linha");
            }

            const key = caseIdentity(row);
            const previous = cases.get(key);

            if (previous === undefined || upsertOptions?.ignoreDuplicates !== true) {
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
        insert: (row: Row) => {
          if (table === "support_case_links") {
            links.push(row);
            return Promise.resolve({ data: null, error: null });
          }

          throw new Error(`insert inesperado em ${table}`);
        },
        update: (updates: Row) => {
          if (table === "support_cases") {
            return updateChain(() => [...cases.values()], updates);
          }

          throw new Error(`update inesperado em ${table}`);
        },
        delete: () => {
          if (table === "support_case_links") {
            return deleteChain(links);
          }

          throw new Error(`delete inesperado em ${table}`);
        },
      };
    },
  };

  return { db: db as never, rpcCalls, cases, messages, links };
}

describe("persistSupportConversation", () => {
  it("cria o case da conversa com pack, caminho e estado remotos", async () => {
    const fake = fakeDb();

    const result = await persistSupportConversation(fake.db, CONTEXT, projection(PACK_REFERENCE));

    expect(result).toMatchObject({ messagesUpserted: 1, linkMode: "EXTERNAL" });
    const stored = [...fake.cases.values()][0];
    expect(stored).toMatchObject({
      channel: "POST_SALE_MESSAGE",
      external_case_key: "message:pack:2000000089077943",
      pack_id: 2000000089077943,
      conversation_path: "/packs/2000000089077943/seller/419059118",
      remote_unread_count: 2,
      remote_reply_state: "ALLOWED",
    });
  });

  it("vendedor respondeu por último pede AGUARDANDO_CLIENTE; cliente respondendo depois pede reabertura (D-102)", async () => {
    const fake = fakeDb();

    // Só o comprador falou: a decisão pura devolve reabertura, mas com
    // expected AGUARDANDO_CLIENTE/RESOLVIDO — num case NOVO o guard do
    // banco não faz nada. O encanamento chama a RPC mesmo assim.
    await persistSupportConversation(fake.db, CONTEXT, projection(PACK_REFERENCE));
    expect(fake.rpcCalls[0]).toMatchObject({
      fn: "apply_support_remote_transition",
      args: { p_new_status: "NOVO", p_event_type: "support.case.auto_reopened" },
    });

    // O vendedor respondeu por último (pelo app do ML ou pela V3): pede
    // AGUARDANDO_CLIENTE, guardado a NOVO.
    await persistSupportConversation(
      fake.db,
      CONTEXT,
      projection(PACK_REFERENCE, [
        buyerMessage("m1"),
        {
          ...buyerMessage("m2"),
          from: { user_id: SELLER_ID },
          to: { user_id: 777 },
          message_date: { created: "2026-08-26T19:00:00.000Z" },
        },
      ]),
    );

    const awaiting = fake.rpcCalls.at(-1);
    expect(awaiting).toMatchObject({
      fn: "apply_support_remote_transition",
      args: {
        p_expected_statuses: ["NOVO"],
        p_new_status: "AGUARDANDO_CLIENTE",
        p_source: "RECONCILIATION",
        p_event_type: "support.case.auto_awaiting_customer",
      },
    });
  });

  it("não sobrescreve triagem humana ao ressincronizar (D-094)", async () => {
    const fake = fakeDb();

    await persistSupportConversation(fake.db, CONTEXT, projection(PACK_REFERENCE));
    const [stored] = [...fake.cases.values()];

    if (stored === undefined) {
      throw new Error("case não foi criado");
    }

    stored.internal_status = "EM_ATENDIMENTO";
    stored.priority = "CRITICA";
    stored.assignee_id = "operador-1";

    await persistSupportConversation(
      fake.db,
      CONTEXT,
      projection(PACK_REFERENCE, [buyerMessage("m1"), buyerMessage("m2")]),
    );

    expect(stored.internal_status).toBe("EM_ATENDIMENTO");
    expect(stored.priority).toBe("CRITICA");
    expect(stored.assignee_id).toBe("operador-1");
    expect(fake.messages.size).toBe(2);
  });

  it("reprocessar a mesma conversa não duplica case nem mensagem", async () => {
    const fake = fakeDb();

    await persistSupportConversation(fake.db, CONTEXT, projection(PACK_REFERENCE));
    await persistSupportConversation(fake.db, CONTEXT, projection(PACK_REFERENCE));

    expect(fake.cases.size).toBe(1);
    expect(fake.messages.size).toBe(1);
  });

  it("liga a conversa a TODOS os pedidos do pack, não só ao primeiro", async () => {
    const fake = fakeDb({
      orders: [
        { id: 1, organization_id: CONTEXT.organizationId, ml_account_id: CONTEXT.mlAccountId, pack_id: 2000000089077943 },
        { id: 2, organization_id: CONTEXT.organizationId, ml_account_id: CONTEXT.mlAccountId, pack_id: 2000000089077943 },
      ],
    });

    const result = await persistSupportConversation(fake.db, CONTEXT, projection(PACK_REFERENCE));

    expect(result).toMatchObject({ linkMode: "TYPED", linkedOrderIds: [1, 2] });
    expect(fake.links.filter((link) => link.link_source === "ORDER_DERIVED")).toHaveLength(2);
  });

  it("conversa de pedido avulso procura pelo id do pedido, não por pack", async () => {
    const fake = fakeDb({
      orders: [
        { id: 1234567871, organization_id: CONTEXT.organizationId, ml_account_id: CONTEXT.mlAccountId, pack_id: null },
      ],
    });

    const result = await persistSupportConversation(
      fake.db,
      CONTEXT,
      projection({ kind: "ORDER", id: "1234567871", sellerId: SELLER_ID }),
    );

    expect(result.linkedOrderIds).toEqual([1234567871]);
    expect([...fake.cases.values()][0]).toMatchObject({
      external_case_key: "message:order:1234567871",
      pack_id: null,
    });
  });

  it("pedido ainda não sincronizado deixa vínculo externo rastreável", async () => {
    const fake = fakeDb();

    await persistSupportConversation(fake.db, CONTEXT, projection(PACK_REFERENCE));

    expect(fake.links).toEqual([
      expect.objectContaining({ external_entity_kind: "PACK", external_entity_id: "2000000089077943" }),
    ]);
  });

  it("quando o pedido aparece depois, o fallback externo dá lugar ao vínculo tipado", async () => {
    const fake = fakeDb();
    await persistSupportConversation(fake.db, CONTEXT, projection(PACK_REFERENCE));
    expect(fake.links).toHaveLength(1);

    const withOrders = fakeDb({
      orders: [
        { id: 1, organization_id: CONTEXT.organizationId, ml_account_id: CONTEXT.mlAccountId, pack_id: 2000000089077943 },
      ],
    });
    withOrders.links.push(...fake.links);

    await persistSupportConversation(withOrders.db, CONTEXT, projection(PACK_REFERENCE));

    expect(withOrders.links).toEqual([
      expect.objectContaining({ order_id: 1, link_source: "ORDER_DERIVED" }),
    ]);
  });

  it("erro ao resolver pedidos aborta com mensagem explícita, não em silêncio", async () => {
    const fake = fakeDb({ ordersError: { message: "conexão perdida" } });

    await expect(
      persistSupportConversation(fake.db, CONTEXT, projection(PACK_REFERENCE)),
    ).rejects.toThrow(/resolver pedidos/);
  });

  it("conversa sem mensagem grava o case sem tentar upsert vazio", async () => {
    const fake = fakeDb();

    const result = await persistSupportConversation(
      fake.db,
      CONTEXT,
      projection(PACK_REFERENCE, []),
    );

    expect(result.messagesUpserted).toBe(0);
    expect(fake.messages.size).toBe(0);
    expect(fake.cases.size).toBe(1);
  });
});
