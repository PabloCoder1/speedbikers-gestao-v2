import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { persistSupportQuestion } from "./persist-support-question.js";

type PersistSupportQuestion = typeof persistSupportQuestion;

const persistSupportQuestionMock = vi.hoisted(() => vi.fn<PersistSupportQuestion>());

vi.mock("./persist-support-question.js", () => ({
  persistSupportQuestion: persistSupportQuestionMock,
}));

const { fetchSupportQuestions } = await import("./ml-support-questions-fetch.js");

const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SELLER_ID = 419_059_118;
const NOW = new Date("2026-08-25T19:00:00.000Z");

function question(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    seller_id: SELLER_ID,
    buyer_id: 419_067_349,
    item_id: "MLB1623490410",
    status: "UNANSWERED",
    text: "O produto ainda está disponível?",
    date_created: "2020-08-20T13:22:01.600-04:00",
    answer: null,
    ...overrides,
  };
}

/** Devolve uma página por chamada, na ordem. */
function pagingClient(pages: Record<string, unknown>[][]): {
  client: MercadoLivreClient;
  requests: RequestOptions<unknown>["searchParams"][];
} {
  const requests: RequestOptions<unknown>["searchParams"][] = [];
  let call = 0;

  const request = <T>(options: RequestOptions<T>): Promise<T> => {
    requests.push(options.searchParams);
    const page = pages[call] ?? [];
    call += 1;

    return Promise.resolve().then(() =>
      options.schema.parse({ total: 999, limit: 100, questions: page }),
    );
  };

  return { client: { request }, requests };
}

function params(client: MercadoLivreClient, lines: string[] = []) {
  return {
    db: {} as never,
    organizationId: ORGANIZATION_ID,
    mlAccountId: ML_ACCOUNT_ID,
    sellerId: SELLER_ID,
    mercadoLivre: client,
    accessToken: "APP_USR-valido",
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    now: () => NOW,
  };
}

/** 100 perguntas — exatamente o limite de página, força a busca da próxima. */
function fullPage(startId: number): Record<string, unknown>[] {
  return Array.from({ length: 100 }, (_unused, index) => question(startId + index));
}

beforeEach(() => {
  persistSupportQuestionMock.mockReset();
  persistSupportQuestionMock.mockResolvedValue({
    supportCaseId: "cccccccc-0000-4000-8000-000000000001",
    messagesUpserted: 1,
    linkMode: "EXTERNAL",
  });
});

describe("fetchSupportQuestions", () => {
  it("busca só UNANSWERED — o único recorte possível sem filtro de data na API", async () => {
    const { client, requests } = pagingClient([[question(1)]]);

    await fetchSupportQuestions(params(client));

    expect(requests[0]).toMatchObject({ status: "UNANSWERED", api_version: 4, offset: 0, limit: 100 });
  });

  it("persiste cada pergunta da página com a projeção mapeada", async () => {
    const { client } = pagingClient([[question(1), question(2)]]);

    const result = await fetchSupportQuestions(params(client));

    expect(result).toMatchObject({ itemsProcessed: 2, itemsFailed: 0, itemsRejected: 0 });
    expect(persistSupportQuestionMock).toHaveBeenCalledTimes(2);
    expect(persistSupportQuestionMock.mock.calls[0]?.[1]).toEqual({
      organizationId: ORGANIZATION_ID,
      mlAccountId: ML_ACCOUNT_ID,
    });
    expect(persistSupportQuestionMock.mock.calls[0]?.[2]).toMatchObject({
      case: { externalCaseKey: "question:1" },
    });
  });

  it("pagina até a página vir menor que o limite, avançando o offset pelo que já leu", async () => {
    const { client, requests } = pagingClient([fullPage(1), fullPage(101), [question(201)]]);

    const result = await fetchSupportQuestions(params(client));

    expect(result.itemsProcessed).toBe(201);
    expect(result.truncated).toBe(false);
    expect(requests.map((entry) => entry?.offset)).toEqual([0, 100, 200]);
  });

  it("página vazia encerra sem persistir nada", async () => {
    const { client, requests } = pagingClient([[]]);

    const result = await fetchSupportQuestions(params(client));

    expect(result).toMatchObject({ itemsProcessed: 0, truncated: false });
    expect(persistSupportQuestionMock).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it("não depende de `total` para decidir o fim — ele pode se mover entre páginas", async () => {
    // `total: 999` em toda página; a varredura para porque a página veio
    // menor que o limite, não porque bateu o total.
    const { client } = pagingClient([[question(1)]]);

    const result = await fetchSupportQuestions(params(client));

    expect(result.remoteTotal).toBe(999);
    expect(result.itemsProcessed).toBe(1);
  });

  it("recusa pergunta de outro seller sem persistir, e conta separado de falha", async () => {
    const { client } = pagingClient([[question(1), question(2, { seller_id: 999_999 })]]);
    const lines: string[] = [];

    const result = await fetchSupportQuestions(params(client, lines));

    expect(result).toMatchObject({ itemsProcessed: 1, itemsRejected: 1, itemsFailed: 0 });
    expect(persistSupportQuestionMock).toHaveBeenCalledTimes(1);
    expect(lines.join()).toContain("support_questions_seller_mismatch");
  });

  it("uma pergunta que falha ao persistir não derruba a varredura das outras", async () => {
    const { client } = pagingClient([[question(1), question(2), question(3)]]);
    const lines: string[] = [];

    persistSupportQuestionMock.mockRejectedValueOnce(new Error("falha ao gravar atendimento"));

    const result = await fetchSupportQuestions(params(client, lines));

    expect(result).toMatchObject({ itemsProcessed: 2, itemsFailed: 1 });
    expect(persistSupportQuestionMock).toHaveBeenCalledTimes(3);
    expect(lines.join()).toContain("support_question_persist_failed");
  });

  it("o texto da pergunta nunca entra no log de falha", async () => {
    const { client } = pagingClient([[question(1, { text: "MEU TELEFONE E 11999998888" })]]);
    const lines: string[] = [];

    persistSupportQuestionMock.mockRejectedValueOnce(new Error("falha ao gravar atendimento"));

    await fetchSupportQuestions(params(client, lines));

    expect(lines.join()).not.toContain("11999998888");
  });

  it("erro de rede NÃO é engolido — sobe para o job classificar e decidir o retry", async () => {
    const request = () =>
      Promise.reject(new MercadoLivreApiError("429 do Mercado Livre", {
        status: 429,
        errorClass: "retryable",
        url: "/my/received_questions/search",
      }));

    await expect(fetchSupportQuestions(params({ request } as MercadoLivreClient))).rejects.toThrow(
      MercadoLivreApiError,
    );
  });

  it("erro no meio da paginação sobe, sem reportar sucesso parcial silencioso", async () => {
    let call = 0;
    const request = <T>(options: RequestOptions<T>): Promise<T> => {
      call += 1;

      if (call === 1) {
        return Promise.resolve().then(() =>
          options.schema.parse({ total: 999, limit: 100, questions: fullPage(1) }),
        );
      }

      return Promise.reject(new MercadoLivreApiError("500 do Mercado Livre", {
        status: 500,
        errorClass: "retryable",
        url: "/my/received_questions/search",
      }));
    };

    await expect(fetchSupportQuestions(params({ request }))).rejects.toThrow(
      MercadoLivreApiError,
    );
  });

  it("trunca no teto de páginas em vez de varrer a API sem limite, e diz que truncou", async () => {
    const pages = Array.from({ length: 25 }, (_unused, index) => fullPage(1 + index * 100));
    const { client, requests } = pagingClient(pages);
    const lines: string[] = [];

    const result = await fetchSupportQuestions(params(client, lines));

    expect(requests).toHaveLength(20);
    expect(result.itemsProcessed).toBe(2_000);
    expect(result.truncated).toBe(true);
    expect(lines.join()).toContain("support_questions_scan_truncated");
  });
});
