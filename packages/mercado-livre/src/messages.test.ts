import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { createMercadoLivreClient } from "./http-client.js";
import {
  classifySender,
  conversationReplyState,
  fetchMessageDetail,
  fetchPackMessages,
  fetchUnreadConversations,
  inferConversationKind,
  mapPackMessagesToSupportProjection,
  messageBodyState,
  messageDetailSchema,
  packMessagesPageSchema,
  parseConversationResource,
  toMessageConversationLocator,
  unreadConversationsSchema,
} from "./messages.js";
import type { PackMessage, PackMessagesPage } from "./messages.js";

const OBSERVED_AT = new Date("2026-08-26T18:00:00.000Z");
const SELLER_ID = 415458330;
const MLB_AGENT_ID = 3037675074;

async function loadFixture(name: string): Promise<unknown> {
  const url = new URL(`../test/fixtures/messages/${name}.json`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}

async function loadConversation(name: string): Promise<PackMessagesPage> {
  return packMessagesPageSchema.parse(await loadFixture(name));
}

function messageWith(overrides: Partial<PackMessage>): PackMessage {
  return packMessagesPageSchema.parse({
    messages: [
      {
        id: "m1",
        from: { user_id: 999 },
        text: "oi",
        message_date: { created: "2026-08-26T12:00:00.000Z" },
        ...overrides,
      },
    ],
  }).messages[0]!;
}

describe("contrato da mensageria pós-venda", () => {
  it("aceita o exemplo da página 'Gestão de mensagens pós-venda'", async () => {
    const page = await loadConversation("conversation-official");

    expect(page.messages).toHaveLength(1);
    expect(page.conversation_status?.status).toBe("active");
    expect(page.seller_max_message_length).toBe(350);
  });

  it("aceita o exemplo da página 'Mensagens pendentes', que diverge do outro", async () => {
    const page = await loadConversation("conversation-pending-doc");
    const message = page.messages[0]!;

    // `user_id` chega como STRING nesta página e como número na outra.
    expect(message.from.user_id).toBe(SELLER_ID);
    expect(message.status).toBe("IN_MODERATION");
    // `to` simplesmente não existe neste payload.
    expect(message.to).toBeNull();
  });

  it("descarta email e nome do comprador em vez de trafegar PII", async () => {
    const page = await loadConversation("conversation-pending-doc");
    const message = page.messages[0]!;

    expect(JSON.stringify(message)).not.toContain("testuser.com");
    expect(JSON.stringify(message)).not.toContain("Juan Pablo");
    expect(Object.keys(message.from)).toEqual(["user_id"]);
  });

  it("aceita status desconhecido em vez de derrubar a conversa inteira", () => {
    const parsed = packMessagesPageSchema.parse({
      messages: [
        {
          id: "m1",
          from: { user_id: 1 },
          status: "UM_STATUS_QUE_AINDA_NAO_EXISTE",
          text: "oi",
        },
      ],
    });

    expect(parsed.messages[0]?.status).toBe("UM_STATUS_QUE_AINDA_NAO_EXISTE");
  });

  it("aceita seller_max_message_length ZERO — observado no payload real do webhook (D-103)", () => {
    // O tráfego real de 2026-08-27 trouxe 0 (provável "vendedor não pode
    // responder"); o `.positive()` original derrubava a conversa inteira
    // por um campo que nenhuma lógica consome.
    const parsed = packMessagesPageSchema.parse({
      messages: [],
      seller_max_message_length: 0,
    });

    expect(parsed.seller_max_message_length).toBe(0);
  });

  it("recusa user_id não numérico, que indicaria payload trocado", () => {
    expect(() =>
      packMessagesPageSchema.parse({
        messages: [{ id: "m1", from: { user_id: "não-numérico" }, text: "oi" }],
      }),
    ).toThrow();
  });

  it("aceita a lista de não lidas cheia e vazia, com user_id número ou string", async () => {
    const full = unreadConversationsSchema.parse(await loadFixture("unread-conversations"));
    const empty = unreadConversationsSchema.parse(await loadFixture("unread-empty"));

    expect(full.results).toEqual([{ resource: "/packs/1977056109/sellers/378136913", count: 1 }]);
    expect(empty.user_id).toBe(1234512314);
    expect(empty.results).toEqual([]);
  });
});

describe("classificação de remetente", () => {
  it("reconhece o vendedor, o Agente de Mensageria e o comprador", () => {
    expect(classifySender(SELLER_ID, SELLER_ID)).toBe("SELLER");
    expect(classifySender(MLB_AGENT_ID, SELLER_ID)).toBe("MERCADO_LIVRE_AGENT");
    expect(classifySender(777, SELLER_ID)).toBe("CUSTOMER");
  });
});

describe("body_state", () => {
  it.each([
    ["available", "AVAILABLE"],
    ["IN_MODERATION", "MODERATED"],
    ["rejected", "MODERATED"],
  ])("mapeia status %s para %s", (status, expected) => {
    expect(messageBodyState(messageWith({ status }))).toBe(expected);
  });

  it("rotula moderação antes de vazio: 'moderada sem texto' diz mais que 'vazia'", () => {
    expect(messageBodyState(messageWith({ status: "rejected", text: "" }))).toBe("MODERATED");
  });

  it("mensagem só com anexo não é vazia — sumiria da tela se fosse", () => {
    expect(
      messageBodyState(messageWith({ text: null, message_attachments: [{ filename: "a.pdf" }] })),
    ).toBe("UNAVAILABLE");
    expect(messageBodyState(messageWith({ text: "  " }))).toBe("EMPTY");
  });

  it("preserva o texto mesmo quando o estado é moderado, como em D-086", async () => {
    const page = await loadConversation("conversation-pending-doc");
    const projection = mapPackMessagesToSupportProjection(
      { kind: "PACK", id: "2000000089077943", sellerId: SELLER_ID },
      page,
      OBSERVED_AT,
    );

    expect(projection.messages[0]?.bodyState).toBe("MODERATED");
    expect(projection.messages[0]?.body).toBe("Test message ToUserId");
  });
});

describe("estado de resposta da conversa", () => {
  it("só 'active' libera; ausência é UNKNOWN e o resto bloqueia com motivo", () => {
    expect(conversationReplyState(null)).toEqual({ state: "UNKNOWN", reason: null });
    expect(
      conversationReplyState({
        path: null,
        status: "active",
        substatus: null,
        status_date: null,
        status_update_allowed: null,
        claim_id: null,
        shipping_id: null,
      }),
    ).toEqual({ state: "ALLOWED", reason: null });
    expect(
      conversationReplyState({
        path: null,
        status: "blocked",
        substatus: "order_cancelled",
        status_date: null,
        status_update_allowed: null,
        claim_id: null,
        shipping_id: null,
      }),
    ).toEqual({ state: "BLOCKED", reason: "BLOCKED:ORDER_CANCELLED" });
  });
});

describe("mapPackMessagesToSupportProjection", () => {
  it("projeta a conversa oficial no read model de support", async () => {
    const page = await loadConversation("conversation-official");
    const projection = mapPackMessagesToSupportProjection(
      { kind: "PACK", id: "2000000089077943", sellerId: SELLER_ID },
      page,
      OBSERVED_AT,
      3,
    );

    expect(projection.case).toMatchObject({
      channel: "POST_SALE_MESSAGE",
      externalCaseKey: "message:pack:2000000089077943",
      externalCaseId: "2000000089077943",
      packId: 2000000089077943,
      remoteUnreadCount: 3,
      remoteReplyState: "ALLOWED",
      initialInternalStatus: "NOVO",
      initialResolvedAt: null,
    });
    expect(projection.messages[0]).toMatchObject({
      externalMessageKey: "message:fd1d2e37ad004ede9e0bf25d1215002d",
      direction: "INBOUND",
      senderKind: "CUSTOMER",
      bodyState: "AVAILABLE",
    });
  });

  it("usa o prefixo de pedido e deixa pack_id nulo quando a conversa é de order", async () => {
    const page = await loadConversation("conversation-official");
    const projection = mapPackMessagesToSupportProjection(
      { kind: "ORDER", id: "1234567871", sellerId: SELLER_ID },
      page,
      OBSERVED_AT,
    );

    expect(projection.case.externalCaseKey).toBe("message:order:1234567871");
    expect(projection.case.packId).toBeNull();
  });

  it("mensagem do vendedor é OUTBOUND e alimenta lastOutboundAt", async () => {
    const page = await loadConversation("conversation-pending-doc");
    const projection = mapPackMessagesToSupportProjection(
      { kind: "PACK", id: "2000000089077943", sellerId: SELLER_ID },
      page,
      OBSERVED_AT,
    );

    expect(projection.messages[0]?.direction).toBe("OUTBOUND");
    expect(projection.messages[0]?.senderKind).toBe("SELLER");
    expect(projection.case.lastOutboundAt).toBe("2019-04-08T20:58:49.000Z");
    expect(projection.case.lastInboundAt).toBeNull();
  });

  it("NUNCA usa o ID do Agente de Mensageria como cliente (D-083)", () => {
    const page = packMessagesPageSchema.parse({
      messages: [
        {
          id: "m1",
          from: { user_id: MLB_AGENT_ID },
          to: { user_id: SELLER_ID },
          text: "o comprador pergunta sobre o prazo",
          message_date: { created: "2026-08-26T12:00:00.000Z" },
        },
      ],
    });
    const projection = mapPackMessagesToSupportProjection(
      { kind: "PACK", id: "1", sellerId: SELLER_ID },
      page,
      OBSERVED_AT,
    );

    expect(projection.messages[0]?.senderKind).toBe("MERCADO_LIVRE_AGENT");
    expect(projection.messages[0]?.direction).toBe("INBOUND");
    expect(projection.case.customerExternalId).toBeNull();
  });

  it("recupera o comprador real pelo destinatário de uma mensagem nossa", () => {
    const page = packMessagesPageSchema.parse({
      messages: [
        {
          id: "m1",
          from: { user_id: SELLER_ID },
          to: { user_id: 777 },
          text: "seu pedido saiu para entrega",
          message_date: { created: "2026-08-26T12:00:00.000Z" },
        },
      ],
    });
    const projection = mapPackMessagesToSupportProjection(
      { kind: "PACK", id: "1", sellerId: SELLER_ID },
      page,
      OBSERVED_AT,
    );

    expect(projection.case.customerExternalId).toBe(777);
  });

  it("status_date POSTERIOR às mensagens não vira atividade — medido em produção", () => {
    // Em 2026-08-27, na primeira ingestão real, `status_date` voltava no
    // instante da consulta. Entrando num `max()`, empurrava todas as conversas
    // para o mesmo horário e destruía a ordenação da Caixa de Entrada.
    const page = packMessagesPageSchema.parse({
      conversation_status: { status: "active", status_date: "2026-08-27T11:24:45.000Z" },
      messages: [
        {
          id: "m1",
          from: { user_id: 777 },
          text: "quando chega?",
          message_date: { created: "2026-08-27T11:22:09.000Z" },
        },
      ],
    });
    const projection = mapPackMessagesToSupportProjection(
      { kind: "PACK", id: "1", sellerId: SELLER_ID },
      page,
      OBSERVED_AT,
    );

    expect(projection.case.lastActivityAt).toBe("2026-08-27T11:22:09.000Z");
  });

  it("conversa sem mensagem ainda produz last_activity_at, que é NOT NULL", () => {
    const page = packMessagesPageSchema.parse({
      conversation_status: { status: "active", status_date: "2026-08-20T10:00:00.000Z" },
      messages: [],
    });
    const projection = mapPackMessagesToSupportProjection(
      { kind: "PACK", id: "1", sellerId: SELLER_ID },
      page,
      OBSERVED_AT,
    );

    expect(projection.case.lastActivityAt).toBe("2026-08-20T10:00:00.000Z");
    expect(projection.messages).toEqual([]);
  });

  it("sem mensagem e sem status_date cai no instante observado, não em data inventada", () => {
    const projection = mapPackMessagesToSupportProjection(
      { kind: "PACK", id: "1", sellerId: SELLER_ID },
      packMessagesPageSchema.parse({ messages: [] }),
      OBSERVED_AT,
    );

    expect(projection.case.lastActivityAt).toBe(OBSERVED_AT.toISOString());
    expect(projection.case.remoteReplyState).toBe("UNKNOWN");
  });
});

describe("descoberta da conversa", () => {
  it("lê pack/order do payload remoto, não do caminho da URL", async () => {
    expect(inferConversationKind(await loadConversation("conversation-official"))).toBe("PACK");
  });

  it("aceita 'seller' e 'sellers', que as duas páginas oficiais grafam diferente", async () => {
    expect(inferConversationKind(await loadConversation("conversation-pending-doc"))).toBe("PACK");
  });

  it("extrai pack e seller do resource de /messages/unread", () => {
    expect(parseConversationResource("/packs/1977056109/sellers/378136913")).toEqual({
      packOrOrderId: "1977056109",
      sellerId: 378136913,
    });
  });

  it("devolve null em resource ilegível, para não derrubar as outras conversas", () => {
    expect(parseConversationResource("/claims/123")).toBeNull();
    expect(parseConversationResource("")).toBeNull();
  });
});

describe("detalhe de mensagem — os dois formatos documentados", () => {
  it("localiza a conversa no formato legado (objeto plano)", async () => {
    const detail = messageDetailSchema.parse(await loadFixture("message-detail-legacy"));

    expect(toMessageConversationLocator(detail)).toEqual({
      messageId: "0033b582a1474fa98c02d229abcec43c",
      kind: "ORDER",
      packOrOrderId: "1234567871",
    });
  });

  it("localiza a conversa no formato de envelope", async () => {
    const detail = messageDetailSchema.parse(await loadFixture("message-detail-envelope"));

    expect(toMessageConversationLocator(detail)).toEqual({
      messageId: "fd1d2e37ad004ede9e0bf25d1215002d",
      kind: "PACK",
      // Zeros à esquerda normalizados: "000011122344" no exemplo oficial.
      packOrOrderId: "11122344",
    });
  });

  it("descarta resource_id não numérico em vez de criar case com chave inválida", () => {
    expect(
      toMessageConversationLocator(
        messageDetailSchema.parse({ message_id: "m1", resource: "orders", resource_id: "abc" }),
      ),
    ).toEqual({ messageId: "m1", kind: null, packOrOrderId: null });
  });
});

describe("adaptadores HTTP", () => {
  function clientSpy(payload: unknown): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      calls.push(url instanceof Request ? url.url : String(url));

      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    return { fetchImpl, calls };
  }

  it("fixa mark_as_read=false: um GET técnico não marca mensagem como lida (D-083)", async () => {
    const { fetchImpl, calls } = clientSpy(await loadFixture("conversation-official"));

    await fetchPackMessages({
      mercadoLivre: createMercadoLivreClient({ fetchImpl }),
      accessToken: "token",
      packOrOrderId: "2000000089077943",
      sellerId: SELLER_ID,
    });

    expect(calls[0]).toContain("/messages/packs/2000000089077943/sellers/415458330");
    expect(calls[0]).toContain("mark_as_read=false");
    expect(calls[0]).toContain("tag=post_sale");
  });

  it("envia role=seller, que a documentação diz não ter valor padrão", async () => {
    const { fetchImpl, calls } = clientSpy(await loadFixture("unread-conversations"));

    await fetchUnreadConversations({
      mercadoLivre: createMercadoLivreClient({ fetchImpl }),
      accessToken: "token",
    });

    expect(calls[0]).toContain("role=seller");
    expect(calls[0]).toContain("tag=post_sale");
  });

  it("busca o detalhe da mensagem com tag=post_sale", async () => {
    const { fetchImpl, calls } = clientSpy(await loadFixture("message-detail-legacy"));

    await fetchMessageDetail({
      mercadoLivre: createMercadoLivreClient({ fetchImpl }),
      accessToken: "token",
      messageId: "0033b582a1474fa98c02d229abcec43c",
    });

    expect(calls[0]).toContain("/messages/0033b582a1474fa98c02d229abcec43c");
    expect(calls[0]).toContain("tag=post_sale");
  });
});
