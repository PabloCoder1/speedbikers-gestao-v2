import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { createMercadoLivreClient } from "./http-client.js";
import {
  fetchReceivedQuestion,
  fetchReceivedQuestionsPage,
  mapQuestionToSupportProjection,
  receivedQuestionSchema,
  receivedQuestionsPageSchema,
} from "./questions.js";

const OBSERVED_AT = new Date("2026-08-25T17:30:00.000Z");

async function loadFixture(name: string): Promise<unknown> {
  const url = new URL(`../test/fixtures/questions/${name}.json`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}

describe("receivedQuestionSchema", () => {
  it.each(["unanswered", "answered", "banned-question", "banned-answer", "under-review"])(
    "aceita o fixture oficial/documentado %s",
    async (name) => {
      const parsed = receivedQuestionSchema.parse(await loadFixture(name));
      expect(parsed.id).toBeGreaterThan(0);
      expect(parsed.item_id).toMatch(/^MLB[0-9]+$/);
    },
  );

  it("aceita a forma paginada das buscas de perguntas", async () => {
    const question = await loadFixture("unanswered");
    const page = receivedQuestionsPageSchema.parse({ total: 1, limit: 50, questions: [question] });

    expect(page.questions).toHaveLength(1);
  });

  it("recusa status não documentado em vez de aceitá-lo silenciosamente", async () => {
    const question = await loadFixture("unanswered");
    expect(() =>
      receivedQuestionSchema.parse({ ...(question as Record<string, unknown>), status: "PENDING" }),
    ).toThrow();
  });

  it("recusa pergunta sem buyer_id nem from.id", async () => {
    const question = await loadFixture("unanswered");
    const withoutBuyer = { ...(question as Record<string, unknown>) };
    delete withoutBuyer.from;
    delete withoutBuyer.buyer_id;

    expect(() => receivedQuestionSchema.parse(withoutBuyer)).toThrow(/buyer_id/);
  });
});

describe("fetchReceivedQuestion", () => {
  it("busca o detalhe v4 autenticado e valida a resposta pelo contrato", async () => {
    const fixture = await loadFixture("unanswered");
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(url as string | URL);
      const headers = init?.headers as Record<string, string>;

      expect(parsed.pathname).toBe("/questions/11436370259");
      expect(parsed.searchParams.get("api_version")).toBe("4");
      expect(init?.method).toBe("GET");
      expect(headers.authorization).toBe("Bearer APP_USR-token-teste");

      return Promise.resolve(
        new Response(JSON.stringify(fixture), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    const mercadoLivre = createMercadoLivreClient({ fetchImpl });

    const question = await fetchReceivedQuestion({
      mercadoLivre,
      accessToken: "APP_USR-token-teste",
      questionId: 11_436_370_259,
    });

    expect(question).toMatchObject({ id: 11_436_370_259, status: "UNANSWERED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("fetchReceivedQuestionsPage", () => {
  it("fixa endpoint, api_version, status, offset e limit exatamente como a documentação oficial declara", async () => {
    const fixture = await loadFixture("unanswered");
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(url as string | URL);
      const headers = init?.headers as Record<string, string>;

      expect(parsed.pathname).toBe("/my/received_questions/search");
      expect(parsed.searchParams.get("api_version")).toBe("4");
      // `status` é um dos `available_filters` que a própria resposta oficial
      // declara — não é parâmetro inventado.
      expect(parsed.searchParams.get("status")).toBe("UNANSWERED");
      expect(parsed.searchParams.get("offset")).toBe("100");
      expect(parsed.searchParams.get("limit")).toBe("100");
      // A doc oficial NÃO documenta `search_type=scan` para este endpoint —
      // só para `/questions/search`. Não pode vazar para cá por descuido.
      expect(parsed.searchParams.get("search_type")).toBeNull();
      expect(init?.method).toBe("GET");
      expect(headers.authorization).toBe("Bearer APP_USR-token-teste");

      return Promise.resolve(
        new Response(JSON.stringify({ total: 1, limit: 100, questions: [fixture] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    const mercadoLivre = createMercadoLivreClient({ fetchImpl });

    const page = await fetchReceivedQuestionsPage({
      mercadoLivre,
      accessToken: "APP_USR-token-teste",
      status: "UNANSWERED",
      offset: 100,
      limit: 100,
    });

    expect(page.total).toBe(1);
    expect(page.questions).toHaveLength(1);
    expect(page.questions[0]).toMatchObject({ id: 11_436_370_259, status: "UNANSWERED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ignora os campos extras da busca (filters, available_filters, available_sorts) sem recusar a resposta", async () => {
    // O payload real traz esses três blocos; o contrato só declara o que o
    // read model usa. Um campo novo do Mercado Livre não pode quebrar a
    // ingestão.
    const fixture = await loadFixture("answered");
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            total: 1,
            limit: 50,
            questions: [fixture],
            filters: { limit: 50, offset: 0, api_version: "4", sorts: [], is_admin: false },
            available_filters: [{ id: "status", name: "Status", type: "text" }],
            available_sorts: ["item_id", "from_id", "date_created", "seller_id"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const page = await fetchReceivedQuestionsPage({
      mercadoLivre: createMercadoLivreClient({ fetchImpl }),
      accessToken: "APP_USR-token-teste",
      status: "UNANSWERED",
      offset: 0,
      limit: 50,
    });

    expect(page.questions).toHaveLength(1);
  });

  it("recusa uma página cujo item não passa no contrato, em vez de persistir lixo", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ total: 1, limit: 50, questions: [{ id: 1, status: "INVENTADO" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(
      fetchReceivedQuestionsPage({
        mercadoLivre: createMercadoLivreClient({ fetchImpl }),
        accessToken: "APP_USR-token-teste",
        status: "UNANSWERED",
        offset: 0,
        limit: 50,
      }),
    ).rejects.toThrow();
  });
});

describe("mapQuestionToSupportProjection", () => {
  it("mapeia pergunta nova para case QUESTION, mensagem inbound e referência do anúncio", async () => {
    const question = receivedQuestionSchema.parse(await loadFixture("unanswered"));
    const projection = mapQuestionToSupportProjection(question, OBSERVED_AT);

    expect(projection.case).toMatchObject({
      channel: "QUESTION",
      externalCaseKey: "question:11436370259",
      externalCaseId: "11436370259",
      externalStatus: "UNANSWERED",
      customerExternalId: 419067349,
      remoteUnreadCount: 0,
      remoteReplyState: "ALLOWED",
      remoteReplyBlockReason: null,
      initialInternalStatus: "NOVO",
      initialResolvedAt: null,
    });
    expect(projection.listingItemId).toBe("MLB1623490410");
    expect(projection.messages).toEqual([
      expect.objectContaining({
        externalMessageKey: "question:11436370259:question",
        direction: "INBOUND",
        senderKind: "CUSTOMER",
        bodyState: "AVAILABLE",
        observedAt: "2026-08-25T17:30:00.000Z",
      }),
    ]);
  });

  it("case que já chega respondido nasce RESOLVIDO e contém a resposta outbound", async () => {
    const question = receivedQuestionSchema.parse(await loadFixture("answered"));
    const projection = mapQuestionToSupportProjection(question, OBSERVED_AT);

    expect(projection.case).toMatchObject({
      externalStatus: "ANSWERED",
      remoteReplyState: "BLOCKED",
      remoteReplyBlockReason: "STATUS_ANSWERED",
      initialInternalStatus: "RESOLVIDO",
      initialResolvedAt: "2020-04-14T23:53:43.069Z",
      lastOutboundAt: "2020-04-14T23:53:43.069Z",
    });
    expect(projection.messages).toHaveLength(2);
    expect(projection.messages[1]).toMatchObject({
      externalMessageKey: "question:6940134223:answer",
      externalMessageId: null,
      direction: "OUTBOUND",
      senderKind: "SELLER",
      body: "Sim, possui filtro interno.",
      bodyState: "AVAILABLE",
      remoteStatus: "ACTIVE",
    });
  });

  it("texto vazio com status BANNED permanece explicitamente banido", async () => {
    const question = receivedQuestionSchema.parse(await loadFixture("banned-question"));
    const projection = mapQuestionToSupportProjection(question, OBSERVED_AT);

    expect(projection.case.initialInternalStatus).toBe("RESOLVIDO");
    expect(projection.messages[0]).toMatchObject({ body: null, bodyState: "BANNED" });
  });

  it("resposta BANNED não vira resposta inexistente", async () => {
    const question = receivedQuestionSchema.parse(await loadFixture("banned-answer"));
    const projection = mapQuestionToSupportProjection(question, OBSERVED_AT);

    expect(projection.messages[1]).toMatchObject({
      body: null,
      bodyState: "BANNED",
      remoteStatus: "BANNED",
    });
  });

  it("UNDER_REVIEW vira conteúdo moderado e bloqueia resposta por hint remoto", async () => {
    const question = receivedQuestionSchema.parse(await loadFixture("under-review"));
    const projection = mapQuestionToSupportProjection(question, OBSERVED_AT);

    expect(projection.case).toMatchObject({
      customerExternalId: 2678328,
      initialInternalStatus: "NOVO",
      remoteReplyState: "BLOCKED",
      remoteReplyBlockReason: "QUESTION_ON_HOLD",
    });
    expect(projection.messages[0]?.bodyState).toBe("MODERATED");
  });
});
