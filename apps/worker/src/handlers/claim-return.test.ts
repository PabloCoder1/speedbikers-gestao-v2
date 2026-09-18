import { MercadoLivreApiError } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { ProcessClaimReturnDeps } from "./claim-return.js";
import { processClaimReturn } from "./claim-return.js";

const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORDER_ID = 2000009229357366;
const CLAIM_ID = "5298178312";
const NOW = new Date("2026-08-23T15:00:00.000Z");
/** `occurred_at` das linhas gravadas do fake: e ele que o ESTORNO_FULL espelha (D-352). */
const GRAVADO_EM = "2026-08-20T10:00:00.000Z";
/**
 * A linha de `orders` que o fake devolve por padrao: pedido pago, sem logistica
 * capturada -- o comportamento de antes da D-352, que os testes antigos fixam.
 * `claim-return` passou a ler `orders` SEMPRE (precisa de `logistic_type`).
 */
const PEDIDO_PADRAO = {
  status: "paid",
  date_created: "2026-08-20T09:00:00.000Z",
  date_last_updated: "2026-08-20T09:00:00.000Z",
  last_updated: null,
  logistic_type: null,
};

const CLAIM_WITH_RETURN = {
  id: 5298178312,
  resource: "order",
  resource_id: ORDER_ID,
  status: "closed",
  type: "mediations",
  related_entities: ["return"],
};

const CLAIM_WITHOUT_RETURN = { ...CLAIM_WITH_RETURN, related_entities: [] };

function returnPayload(overrides: {
  status?: string;
  total_quantity?: string;
  return_quantity?: string;
  variation_id?: number | null;
}): Record<string, unknown> {
  return {
    id: 57341011,
    claim_id: 5298178312,
    status: overrides.status ?? "delivered",
    orders: [
      {
        order_id: ORDER_ID,
        item_id: "MLB3840513395",
        variation_id: overrides.variation_id ?? null,
        context_type: "total",
        total_quantity: overrides.total_quantity ?? "1.0",
        return_quantity: overrides.return_quantity ?? "1.0",
      },
    ],
  };
}

interface FakeDbOptions {
  orderItemPosition?: number | null;
  /** Movimentos do pedido (`VENDA_ML` por padrão; `CANCELAMENTO_ML` com `movement_type`). */
  saleMovements?: {
    sku_id: string;
    qty_delta: number;
    idempotency_key: string;
    movement_type?: string;
    occurred_at?: string;
  }[];
  /** `DEVOLUCAO_ML` gravadas, por `get_order_return_movements` (verificação de e6fda07, ALTA-1). */
  recordedReturns?: { sku_id: string; qty_delta: number; idempotency_key: string }[];
  /** Simula falha da leitura das devoluções gravadas. */
  returnsReadError?: boolean;
  /** Simula a leitura das devoluções voltando com `data` nulo e SEM erro. */
  returnsDataNull?: boolean;
  orderItemsError?: boolean;
  saleMovementsError?: boolean;
  /** D-104: força a projeção de atendimento a falhar, sem tocar no estoque. */
  supportError?: boolean;
  /**
   * A linha de `orders` que `claim-return` lê quando o pedido tem venda estornada
   * (reverificação de 60c7a6a, BAIXA-1). Padrão, nenhuma.
   */
  order?: {
    status: string;
    date_created: string;
    date_last_updated: string;
    last_updated: string | null;
    logistic_type?: string | null;
  } | null;
  /** Simula falha da leitura do pedido. */
  orderReadError?: boolean;
  /** Linhas de `get_erp_stock_cutoffs`. Padrão, nenhuma. */
  cutoffRows?: unknown[];
}

interface Captured {
  movements: Record<string, unknown>[];
  events: Record<string, unknown>[];
  supportCases: Record<string, unknown>[];
}

function fakeDb(options: FakeDbOptions, captured: Captured, rpcCalls: string[] = []): ProcessClaimReturnDeps["db"] {
  const position = "orderItemPosition" in options ? options.orderItemPosition : 0;
  const movements = (
    options.saleMovements ?? [{ sku_id: "sku-a", qty_delta: -1, idempotency_key: `venda:${String(ORDER_ID)}:0` }]
  ).map((row) => ({ movement_type: "VENDA_ML", occurred_at: GRAVADO_EM, ...row }));

  return {
    from: (table: string) => {
      if (table === "order_items") {
        const terminal = {
          maybeSingle: () =>
            Promise.resolve(
              options.orderItemsError === true
                ? { data: null, error: { code: "42P01", message: "boom" } }
                : { data: position === null ? null : { position }, error: null },
            ),
        };

        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                is: () => terminal,
                eq: () => terminal,
              }),
            }),
          }),
        };
      }

      if (table === "stock_movements") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  // `.in("movement_type", ["VENDA_ML", "CANCELAMENTO_ML"])` desde a verificação de e6fda07.
                  // O filtro de tipo é respeitado: deixar de pedir `CANCELAMENTO_ML` não passa pelo fake.
                  in: (_coluna: string, tipos: string[]) =>
                    Promise.resolve(
                      options.saleMovementsError === true
                        ? { data: null, error: { code: "42P01", message: "boom" } }
                        : { data: movements.filter((row) => tipos.includes(row.movement_type)), error: null },
                    ),
                }),
              }),
            }),
          }),
          // upsert desde D-092 (ON CONFLICT DO NOTHING); o fake aceita os
          // dois verbos porque o teste verifica O QUE foi gravado.
          upsert: (row: Record<string, unknown>) => {
            captured.movements.push(row);

            return Promise.resolve({ error: null });
          },
        };
      }

      if (table === "domain_events") {
        return {
          upsert: (row: Record<string, unknown>) => {
            captured.events.push(row);

            return Promise.resolve({ error: null });
          },
        };
      }

      // D-104 — tabelas da projeção de atendimento.
      if (table === "support_cases") {
        return {
          upsert: (row: Record<string, unknown>) => {
            captured.supportCases.push(row);

            return Promise.resolve({ data: null, error: null });
          },
          update: () => ({
            eq: function eq() {
              return this;
            },
            select: () => ({
              single: () =>
                Promise.resolve(
                  options.supportError === true
                    ? { data: null, error: { message: "banco de atendimento fora do ar" } }
                    : { data: { id: "case-1" }, error: null },
                ),
            }),
          }),
        };
      }

      if (table === "orders") {
        return {
          select: (colunas: string) => ({
            eq: function eq() {
              return this;
            },
            // A projeção de atendimento resolve o pedido por `id` (sem linha, o vínculo externo);
            // a devolução lê o status e os instantes da venda estornada (reverificação de 60c7a6a).
            maybeSingle: () => {
              if (!colunas.includes("date_last_updated")) {
                return Promise.resolve({ data: null, error: null });
              }

              return Promise.resolve(
                options.orderReadError === true
                  ? { data: null, error: { code: "42P01", message: "boom" } }
                  : { data: "order" in options ? options.order : PEDIDO_PADRAO, error: null },
              );
            },
          }),
        };
      }

      if (table === "support_case_links") {
        return { insert: () => Promise.resolve({ data: null, error: null }) };
      }

      throw new Error(`tabela inesperada no fake: ${table}`);
    },
    rpc: (fn: string) => {
      rpcCalls.push(fn);

      if (fn === "get_erp_stock_cutoffs") {
        return Promise.resolve({ data: options.cutoffRows ?? [], error: null });
      }

      if (fn === "get_order_return_movements") {
        if (options.returnsDataNull === true) {
          return Promise.resolve({ data: null, error: null });
        }

        return Promise.resolve(
          options.returnsReadError === true
            ? { data: null, error: { code: "42P01", message: "boom" } }
            : {
                data: (options.recordedReturns ?? []).map((row) => ({
                  order_id: String(ORDER_ID),
                  occurred_at: GRAVADO_EM,
                  ...row,
                })),
                error: null,
              },
        );
      }

      return Promise.resolve({ data: true, error: null });
    },
  } as unknown as ProcessClaimReturnDeps["db"];
}

function fakeMercadoLivre(responses: {
  claim?: Record<string, unknown>;
  claimReturn?: Record<string, unknown>;
}): { client: MercadoLivreClient; requests: RequestOptions<unknown>[] } {
  const requests: RequestOptions<unknown>[] = [];

  const client = {
    request: (options: RequestOptions<unknown>) => {
      requests.push(options);

      if (options.path.includes("/returns")) {
        return Promise.resolve(responses.claimReturn ?? returnPayload({}));
      }

      return Promise.resolve(responses.claim ?? CLAIM_WITH_RETURN);
    },
  } as unknown as MercadoLivreClient;

  return { client, requests };
}

const logger = createLogger({}, { sink: () => undefined });

/**
 * D-344 — 381 falhas em 7 dias, 147 claims: o claim já anuncia a devolução e
 * `GET /v2/claims/{id}/returns` responde 404; 145 destravam sozinhos em até
 * 4,1 minutos. Recém-nascido é propagação, não falha. Velho continua falha.
 */
describe("processClaimReturn — devolução ainda não propagada (D-344)", () => {
  const minutosAntesDeAgora = (minutos: number): string => new Date(NOW.getTime() - minutos * 60_000).toISOString();

  function erroDoMercadoLivre(status: number): MercadoLivreApiError {
    const url = `https://api.mercadolibre.com/post-purchase/v2/claims/${CLAIM_ID}/returns`;

    return new MercadoLivreApiError(`Mercado Livre respondeu ${String(status)} para GET ${url}.`, {
      status,
      errorClass: status === 404 ? "not_retryable" : "retryable",
      url,
    });
  }

  interface Registro {
    nivel: "info" | "warn";
    evento: string;
    campos: Record<string, unknown>;
  }

  async function processar(
    claim: Record<string, unknown>,
    erroNaDevolucao: Error,
  ): Promise<{ resultado: Promise<number>; captured: Captured; registros: Registro[] }> {
    const captured: Captured = { movements: [], events: [], supportCases: [] };
    const registros: Registro[] = [];
    const registrar =
      (nivel: Registro["nivel"]) =>
      (evento: string, campos: Record<string, unknown> = {}) => {
        registros.push({ nivel, evento, campos });
      };

    const client = {
      request: (options: RequestOptions<unknown>) =>
        options.path.includes("/returns") ? Promise.reject(erroNaDevolucao) : Promise.resolve(claim),
    } as unknown as MercadoLivreClient;

    const resultado = processClaimReturn(
      { db: fakeDb({}, captured), mercadoLivre: client },
      { organizationId: ORGANIZATION_ID, mlAccountId: ML_ACCOUNT_ID },
      "token",
      CLAIM_ID,
      NOW,
      { ...logger, info: registrar("info"), warn: registrar("warn") },
    );

    // Deixa a promessa assentar antes de o teste ler os registros.
    await resultado.catch(() => undefined);

    return { resultado, captured, registros };
  }

  it("claim de 10 minutos com devolução ainda em 404: processa zero, sem falhar, e registra a propagação", async () => {
    const erro = erroDoMercadoLivre(404);
    const { resultado, captured, registros } = await processar(
      { ...CLAIM_WITH_RETURN, date_created: minutosAntesDeAgora(10) },
      erro,
    );

    await expect(resultado).resolves.toBe(0);
    expect(captured.movements).toHaveLength(0);
    expect(registros).toContainEqual({
      nivel: "info",
      evento: "claim_return_not_yet_available",
      campos: { claim_id: CLAIM_ID, claim_age_min: 10 },
    });
    expect(registros.some((r) => r.evento === "claim_return_missing")).toBe(false);
  });

  it("claim de 2 dias com devolução em 404: continua falhando, e o aviso leva a idade", async () => {
    const erro = erroDoMercadoLivre(404);
    const { resultado, registros } = await processar(
      { ...CLAIM_WITH_RETURN, date_created: minutosAntesDeAgora(2 * 24 * 60) },
      erro,
    );

    await expect(resultado).rejects.toBe(erro);
    expect(registros).toContainEqual({
      nivel: "warn",
      evento: "claim_return_missing",
      campos: { claim_id: CLAIM_ID, claim_age_min: 2880 },
    });
  });

  it("claim sem date_created com devolução em 404: sem idade não há como saber, continua falhando", async () => {
    const erro = erroDoMercadoLivre(404);
    const { resultado, registros } = await processar(CLAIM_WITH_RETURN, erro);

    await expect(resultado).rejects.toBe(erro);
    expect(registros).toContainEqual({
      nivel: "warn",
      evento: "claim_return_missing",
      campos: { claim_id: CLAIM_ID, claim_age_min: null },
    });
  });

  it("limite da janela: 59 minutos ainda é propagação, 60 já é anomalia", async () => {
    const aos59 = await processar({ ...CLAIM_WITH_RETURN, date_created: minutosAntesDeAgora(59) }, erroDoMercadoLivre(404));
    const aos60 = await processar({ ...CLAIM_WITH_RETURN, date_created: minutosAntesDeAgora(60) }, erroDoMercadoLivre(404));

    await expect(aos59.resultado).resolves.toBe(0);
    await expect(aos60.resultado).rejects.toBeInstanceOf(MercadoLivreApiError);
  });

  it("claim recente com erro que NÃO é 404 continua falhando: só o 404 é propagação", async () => {
    const erro = erroDoMercadoLivre(503);
    const { resultado, registros } = await processar(
      { ...CLAIM_WITH_RETURN, date_created: minutosAntesDeAgora(5) },
      erro,
    );

    await expect(resultado).rejects.toBe(erro);
    expect(registros.some((r) => r.evento === "claim_return_not_yet_available")).toBe(false);
  });

  it("carimbo no futuro (relógios diferentes) conta como recém-nascido, não como antigo", async () => {
    const futuro = new Date(NOW.getTime() + 2 * 60_000).toISOString();
    const { resultado, registros } = await processar({ ...CLAIM_WITH_RETURN, date_created: futuro }, erroDoMercadoLivre(404));

    await expect(resultado).resolves.toBe(0);
    expect(registros).toContainEqual({
      nivel: "info",
      evento: "claim_return_not_yet_available",
      campos: { claim_id: CLAIM_ID, claim_age_min: 0 },
    });
  });
});

describe("processClaimReturn (D-057)", () => {
  it("claim sem devolução associada (related_entities vazio): não busca returns, processa zero", async () => {
    const captured: Captured = { movements: [], events: [], supportCases: [] };
    const { client, requests } = fakeMercadoLivre({ claim: CLAIM_WITHOUT_RETURN });

    const processed = await processClaimReturn(
      { db: fakeDb({}, captured), mercadoLivre: client },
      { organizationId: ORGANIZATION_ID, mlAccountId: ML_ACCOUNT_ID },
      "token",
      CLAIM_ID,
      NOW,
      logger,
    );

    expect(processed).toBe(0);
    expect(requests).toHaveLength(1);
    expect(captured.movements).toHaveLength(0);
  });

  it("claim de recurso diferente de 'order' (ex.: payment): ignora", async () => {
    const captured: Captured = { movements: [], events: [], supportCases: [] };
    const { client } = fakeMercadoLivre({ claim: { ...CLAIM_WITH_RETURN, resource: "payment" } });

    const processed = await processClaimReturn(
      { db: fakeDb({}, captured), mercadoLivre: client },
      { organizationId: ORGANIZATION_ID, mlAccountId: ML_ACCOUNT_ID },
      "token",
      CLAIM_ID,
      NOW,
      logger,
    );

    expect(processed).toBe(0);
  });

  it("devolução ainda não entregue (status != delivered): não reverte ainda", async () => {
    const captured: Captured = { movements: [], events: [], supportCases: [] };
    const { client } = fakeMercadoLivre({ claimReturn: returnPayload({ status: "shipped" }) });

    const processed = await processClaimReturn(
      { db: fakeDb({}, captured), mercadoLivre: client },
      { organizationId: ORGANIZATION_ID, mlAccountId: ML_ACCOUNT_ID },
      "token",
      CLAIM_ID,
      NOW,
      logger,
    );

    expect(processed).toBe(0);
    expect(captured.movements).toHaveLength(0);
  });

  it("devolução total entregue: reverte o movimento e grava order.returned", async () => {
    const captured: Captured = { movements: [], events: [], supportCases: [] };
    const { client } = fakeMercadoLivre({});

    const processed = await processClaimReturn(
      { db: fakeDb({}, captured), mercadoLivre: client },
      { organizationId: ORGANIZATION_ID, mlAccountId: ML_ACCOUNT_ID },
      "token",
      CLAIM_ID,
      NOW,
      logger,
    );

    expect(processed).toBe(1);
    expect(captured.movements).toHaveLength(1);
    expect(captured.movements[0]).toMatchObject({
      sku_id: "sku-a",
      qty_delta: 1,
      movement_type: "DEVOLUCAO_ML",
      source_type: "CLAIM",
      source_id: CLAIM_ID,
    });
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({ event_type: "order.returned", ml_account_id: ML_ACCOUNT_ID });
  });

  // D-351: a venda anterior à planilha do UpSeller é gravada E estornada. A
  // devolução entregue continua revertendo — a base é o `VENDA_ML`, que segue
  // gravado; sem ele, sairia "revisão manual" e uma notificação por devolução.
  it("devolução entregue de venda estornada (anterior à planilha) reverte normalmente (D-351)", async () => {
    const captured: Captured = { movements: [], events: [], supportCases: [] };
    const { client } = fakeMercadoLivre({});

    await processClaimReturn(
      {
        db: fakeDb(
          { saleMovements: [{ sku_id: "sku-a", qty_delta: -1, idempotency_key: `venda:${String(ORDER_ID)}:0` }] },
          captured,
        ),
        mercadoLivre: client,
      },
      { organizationId: ORGANIZATION_ID, mlAccountId: ML_ACCOUNT_ID },
      "token",
      CLAIM_ID,
      NOW,
      logger,
    );

    expect(captured.movements).toEqual([
      expect.objectContaining({ movement_type: "DEVOLUCAO_ML", qty_delta: 1, sku_id: "sku-a" }),
    ]);
    expect((captured.events[0] as { after: Record<string, unknown> }).after).toMatchObject({
      fullReversal: true,
      needsManualReview: false,
    });
  });

  it("devolução parcial entregue: não reverte, mas grava o evento para investigação", async () => {
    const captured: Captured = { movements: [], events: [], supportCases: [] };
    const { client } = fakeMercadoLivre({
      claimReturn: returnPayload({ total_quantity: "5.0", return_quantity: "2.0" }),
    });

    const processed = await processClaimReturn(
      { db: fakeDb({ saleMovements: [{ sku_id: "sku-a", qty_delta: -5, idempotency_key: `venda:${String(ORDER_ID)}:0` }] }, captured), mercadoLivre: client },
      { organizationId: ORGANIZATION_ID, mlAccountId: ML_ACCOUNT_ID },
      "token",
      CLAIM_ID,
      NOW,
      logger,
    );

    expect(processed).toBe(1);
    expect(captured.movements).toHaveLength(0);
    expect(captured.events[0]).toMatchObject({ event_type: "order.returned" });
  });

  /**
   * Este teste AFIRMAVA `captured.events` vazio — "pula sem lançar" (D-057).
   * Estava certo para o contrato de então e é justamente o buraco que D-208
   * fecha: a devolução perdida não deixava rastro NENHUM no banco, só um
   * `logger.warn` no Cloud Run. Reescrito, não removido.
   */
  it("item devolvido não encontrado: não reverte, mas REGISTRA a perda (D-208)", async () => {
    const captured: Captured = { movements: [], events: [], supportCases: [] };
    const { client } = fakeMercadoLivre({});

    const processed = await processClaimReturn(
      { db: fakeDb({ orderItemPosition: null }, captured), mercadoLivre: client },
      { organizationId: ORGANIZATION_ID, mlAccountId: ML_ACCOUNT_ID },
      "token",
      CLAIM_ID,
      NOW,
      logger,
    );

    // Continua sem reverter: sem a `position` não há como localizar a venda,
    // e inventar o movimento seria pior que não gravá-lo.
    expect(processed).toBe(0);
    expect(captured.movements).toHaveLength(0);

    // O que mudou: agora a perda é consultável no banco.
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      event_type: "order.return.unreversed",
      severity: "critico",
    });
  });

  it("falha ao ler order_items rejeita — indistinguível de 'não encontrado' seria pior: pularia uma devolução real", async () => {
    const captured: Captured = { movements: [], events: [], supportCases: [] };
    const { client } = fakeMercadoLivre({});

    await expect(
      processClaimReturn(
        { db: fakeDb({ orderItemsError: true }, captured), mercadoLivre: client },
        { organizationId: ORGANIZATION_ID, mlAccountId: ML_ACCOUNT_ID },
        "token",
        CLAIM_ID,
        NOW,
        logger,
      ),
    ).rejects.toThrow(/order_items/);

    expect(captured.movements).toHaveLength(0);
  });

  it("falha ao ler stock_movements existentes rejeita, em vez de reverter zero", async () => {
    const captured: Captured = { movements: [], events: [], supportCases: [] };
    const { client } = fakeMercadoLivre({});

    await expect(
      processClaimReturn(
        { db: fakeDb({ saleMovementsError: true }, captured), mercadoLivre: client },
        { organizationId: ORGANIZATION_ID, mlAccountId: ML_ACCOUNT_ID },
        "token",
        CLAIM_ID,
        NOW,
        logger,
      ),
    ).rejects.toThrow(/stock_movements/);

    expect(captured.movements).toHaveLength(0);
  });
});

describe("processClaimReturn — projeção de atendimento (D-104)", () => {
  /** Claim datado: sem `date_created`/`last_updated` o mapper recusa de propósito. */
  const DATED_CLAIM = {
    ...CLAIM_WITH_RETURN,
    status: "opened",
    stage: "dispute",
    date_created: "2026-08-27T10:00:00.000-03:00",
    last_updated: "2026-08-27T12:00:00.000-03:00",
  };

  async function run(options: FakeDbOptions, claim: Record<string, unknown>) {
    const captured: Captured = { movements: [], events: [], supportCases: [] };
    const { client } = fakeMercadoLivre({ claim });

    const processed = await processClaimReturn(
      { db: fakeDb(options, captured), mercadoLivre: client },
      { organizationId: ORGANIZATION_ID, mlAccountId: ML_ACCOUNT_ID },
      "token",
      CLAIM_ID,
      NOW,
      logger,
    );

    return { captured, processed };
  }

  it("projeta o case MESMO sem devolução — é o motivo de a chamada vir antes do early return", async () => {
    // Uma reclamação sem devolução (mediação, disputa de pagamento) é
    // justamente o que a Caixa de Entrada precisa mostrar. Se a projeção
    // estivesse depois do early return, só apareceriam claims que já
    // reverteram estoque.
    const { captured, processed } = await run({}, { ...DATED_CLAIM, related_entities: [] });

    expect(processed).toBe(0);
    expect(captured.movements).toHaveLength(0);
    expect(captured.supportCases).toHaveLength(1);
    expect(captured.supportCases[0]?.channel).toBe("CLAIM");
    expect(captured.supportCases[0]?.is_mediation).toBe(true);
    expect(captured.supportCases[0]?.priority).toBe("CRITICA");
  });

  it("projeta o case de claim que NÃO é sobre pedido (ex.: payment)", async () => {
    const { captured } = await run({}, { ...DATED_CLAIM, resource: "payment", related_entities: [] });

    expect(captured.supportCases).toHaveLength(1);
  });

  it("falha na projeção de atendimento NÃO impede a reversão de estoque", async () => {
    // A fronteira que o usuário aprovou: dois domínios num handler só, com o
    // financeiro protegido. Estoque é dado de negócio e já roda em produção
    // desde D-057; SAC é projeção de leitura e reconverge na próxima
    // notificação, porque a persistência é idempotente.
    const { captured, processed } = await run({ supportError: true }, DATED_CLAIM);

    expect(processed).toBe(1);
    expect(captured.movements).toHaveLength(1);
    expect(captured.events).toHaveLength(1);
  });

  it("claim sem carimbo de tempo do ML é pulado, e o estoque segue normalmente", async () => {
    // `CLAIM_WITH_RETURN` (fixture de D-057) não tem data nenhuma — o mapper
    // recusa em vez de inventar `now()`, e a reversão continua acontecendo.
    const { captured, processed } = await run({}, CLAIM_WITH_RETURN);

    expect(processed).toBe(1);
    expect(captured.movements).toHaveLength(1);
    expect(captured.supportCases).toHaveLength(0);
  });
});

/**
 * Verificação de e6fda07 (D-351), ALTA-1: cancelamento e devolução entregue
 * revertem a MESMA venda, e a unidade volta ao estoque no máximo uma vez.
 */
describe("processClaimReturn — a unidade volta ao estoque no máximo uma vez (verificação de e6fda07, ALTA-1)", () => {
  const VENDA = `venda:${String(ORDER_ID)}:0`;

  async function processa(options: FakeDbOptions): Promise<{ captured: Captured; rpcCalls: string[] }> {
    const captured: Captured = { movements: [], events: [], supportCases: [] };
    const rpcCalls: string[] = [];
    const { client } = fakeMercadoLivre({});

    await processClaimReturn(
      { db: fakeDb(options, captured, rpcCalls), mercadoLivre: client },
      { organizationId: ORGANIZATION_ID, mlAccountId: ML_ACCOUNT_ID },
      "token",
      CLAIM_ID,
      NOW,
      logger,
    );

    return { captured, rpcCalls };
  }

  it("trio gravado (venda anterior à planilha, cancelada depois dela) e a devolução entregue em seguida: nenhum DEVOLUCAO_ML, e o evento registra a venda já revertida", async () => {
    const { captured } = await processa({
      saleMovements: [
        { sku_id: "sku-a", qty_delta: -1, idempotency_key: VENDA },
        { sku_id: "sku-a", qty_delta: 1, idempotency_key: `cancelamento:${VENDA}`, movement_type: "CANCELAMENTO_ML" },
      ],
    });

    expect(captured.movements).toEqual([]);
    expect((captured.events[0] as { after: Record<string, unknown> }).after).toMatchObject({
      fullReversal: true,
      movementsReversed: 0,
      movementsAlreadyReversed: 1,
    });
  });

  it("outra devolução (outro claim) já devolveu a venda: nada, e a leitura foi pela RPC das devoluções", async () => {
    const { captured, rpcCalls } = await processa({
      recordedReturns: [{ sku_id: "sku-a", qty_delta: 1, idempotency_key: `devolucao:5299999999:${VENDA}` }],
    });

    expect(captured.movements).toEqual([]);
    expect(rpcCalls).toContain("get_order_return_movements");
  });

  it("reprocessar a MESMA devolução já gravada: o movimento sai igual ao da primeira vez (o UNIQUE o absorve)", async () => {
    const { captured } = await processa({
      recordedReturns: [{ sku_id: "sku-a", qty_delta: 1, idempotency_key: `devolucao:${CLAIM_ID}:${VENDA}` }],
    });

    expect(captured.movements).toEqual([
      expect.objectContaining({ movement_type: "DEVOLUCAO_ML", qty_delta: 1, idempotency_key: `devolucao:${CLAIM_ID}:${VENDA}` }),
    ]);
  });

  it("falha na leitura das devoluções gravadas rejeita, em vez de devolver a unidade de novo", async () => {
    await expect(processa({ returnsReadError: true })).rejects.toThrow(/devolucoes gravadas.*boom/);
  });

  it("leitura das devoluções com data nulo e sem erro também rejeita — nunca vira 'nenhuma devolução'", async () => {
    await expect(processa({ returnsDataNull: true })).rejects.toThrow(/devolucoes gravadas.*data nulo sem erro/);
  });

  // Devolução PARCIAL: o domínio não soma as reversões (nada é revertido), e só a
  // conferência da leitura grita com a chave corrompida.
  const PARCIAL = returnPayload({ total_quantity: "2.0", return_quantity: "1.0" });

  async function processaParcial(options: FakeDbOptions): Promise<void> {
    const captured: Captured = { movements: [], events: [], supportCases: [] };
    const { client } = fakeMercadoLivre({ claimReturn: PARCIAL });

    await processClaimReturn(
      { db: fakeDb(options, captured), mercadoLivre: client },
      { organizationId: ORGANIZATION_ID, mlAccountId: ML_ACCOUNT_ID },
      "token",
      CLAIM_ID,
      NOW,
      logger,
    );
  }

  it("cancelamento gravado com chave fora do formato LANÇA na leitura, mesmo numa devolução parcial que não o usaria", async () => {
    await expect(
      processaParcial({
        saleMovements: [
          { sku_id: "sku-a", qty_delta: -1, idempotency_key: VENDA },
          { sku_id: "sku-a", qty_delta: 1, idempotency_key: `cancelamento:${String(ORDER_ID)}:0`, movement_type: "CANCELAMENTO_ML" },
        ],
      }),
    ).rejects.toThrow(/chave de reversao fora do formato/);
  });

  it("devolução gravada com chave fora do formato LANÇA na leitura, mesmo numa devolução parcial que não a usaria", async () => {
    await expect(
      processaParcial({
        recordedReturns: [{ sku_id: "sku-a", qty_delta: 1, idempotency_key: `devolucao:${VENDA}` }],
      }),
    ).rejects.toThrow(/chave de reversao fora do formato/);
  });
});

/**
 * Reverificação de 60c7a6a (D-351), BAIXA-1: a venda estornada cancelada até a
 * exportação não grava `CANCELAMENTO_ML` -- a planilha já tem a unidade de volta --,
 * e a devolução entregue depois devolvia a unidade uma segunda vez.
 */
describe("processClaimReturn — o cancelamento que a planilha já contém (reverificação de 60c7a6a, BAIXA-1)", () => {
  const VENDA = `venda:${String(ORDER_ID)}:0`;
  const ESTORNADA = [
    { sku_id: "sku-a", qty_delta: -1, idempotency_key: VENDA },
    { sku_id: "sku-a", qty_delta: 1, idempotency_key: `estorno:${VENDA}`, movement_type: "ESTORNO_PRE_CAPTURA" },
  ];
  // A planilha 2, exportada em 09-16 12:00 e reconciliada às 13:00.
  const PLANILHA_2 = [
    {
      sku_id: "sku-a",
      captured_at: "2026-09-16T12:00:00+00:00",
      imported_at: "2026-09-16T12:02:00+00:00",
      reconciled_at: "2026-09-16T13:00:00+00:00",
      exported_at: "2026-09-16T12:00:00+00:00",
    },
  ];
  // O cancelamento de 09-16 10:00, visto pela janela horária só depois do import da planilha 2.
  const CANCELADO_ANTES = {
    status: "cancelled",
    date_created: "2026-09-10T14:55:00+00:00",
    date_last_updated: "2026-09-16T10:00:00+00:00",
    last_updated: "2026-09-16T10:00:00+00:00",
  };

  async function processa(options: FakeDbOptions): Promise<{ captured: Captured; rpcCalls: string[] }> {
    const captured: Captured = { movements: [], events: [], supportCases: [] };
    const rpcCalls: string[] = [];
    const { client } = fakeMercadoLivre({});

    await processClaimReturn(
      { db: fakeDb(options, captured, rpcCalls), mercadoLivre: client },
      { organizationId: ORGANIZATION_ID, mlAccountId: ML_ACCOUNT_ID },
      "token",
      CLAIM_ID,
      NOW,
      logger,
    );

    return { captured, rpcCalls };
  }

  const after = (captured: Captured): Record<string, unknown> => (captured.events[0] as { after: Record<string, unknown> }).after;

  it("venda estornada e pedido cancelado até a exportação (o cancelamento foi pulado): nenhum DEVOLUCAO_ML, e o evento registra a venda já revertida", async () => {
    const { captured, rpcCalls } = await processa({ saleMovements: ESTORNADA, order: CANCELADO_ANTES, cutoffRows: PLANILHA_2 });

    expect(captured.movements).toEqual([]);
    expect(after(captured)).toMatchObject({ fullReversal: true, movementsReversed: 0, movementsAlreadyReversed: 1 });
    expect(rpcCalls).toContain("get_erp_stock_cutoffs");
  });

  it("contraprova: venda NÃO estornada, com o cancelamento gravado -- a devolução sai 0 pelo limite, sem ler o corte", async () => {
    const { captured, rpcCalls } = await processa({
      saleMovements: [
        { sku_id: "sku-a", qty_delta: -1, idempotency_key: VENDA },
        { sku_id: "sku-a", qty_delta: 1, idempotency_key: `cancelamento:${VENDA}`, movement_type: "CANCELAMENTO_ML" },
      ],
      order: CANCELADO_ANTES,
      cutoffRows: PLANILHA_2,
    });

    expect(captured.movements).toEqual([]);
    expect(after(captured)).toMatchObject({ movementsAlreadyReversed: 1 });
    expect(rpcCalls).not.toContain("get_erp_stock_cutoffs");
  });

  it("venda estornada e pedido cancelado DEPOIS da exportação, com o cancelamento ainda não gravado: a devolução devolve", async () => {
    const { captured } = await processa({
      saleMovements: ESTORNADA,
      order: { ...CANCELADO_ANTES, date_last_updated: "2026-09-16T12:00:01+00:00", last_updated: "2026-09-16T12:00:01+00:00" },
      cutoffRows: PLANILHA_2,
    });

    expect(captured.movements).toEqual([expect.objectContaining({ movement_type: "DEVOLUCAO_ML", qty_delta: 1 })]);
  });

  it("venda estornada e cancelamento sem instante conhecido (date_last_updated = date_created, sem last_updated): a devolução devolve", async () => {
    const { captured } = await processa({
      saleMovements: ESTORNADA,
      order: { ...CANCELADO_ANTES, date_last_updated: CANCELADO_ANTES.date_created, last_updated: null },
      cutoffRows: PLANILHA_2,
    });

    expect(captured.movements).toEqual([expect.objectContaining({ movement_type: "DEVOLUCAO_ML", qty_delta: 1 })]);
  });

  it("venda estornada e pedido ainda pago: a devolução devolve, sem ler o corte", async () => {
    const { captured, rpcCalls } = await processa({
      saleMovements: ESTORNADA,
      order: { ...CANCELADO_ANTES, status: "paid" },
      cutoffRows: PLANILHA_2,
    });

    expect(captured.movements).toEqual([expect.objectContaining({ movement_type: "DEVOLUCAO_ML", qty_delta: 1 })]);
    expect(rpcCalls).not.toContain("get_erp_stock_cutoffs");
  });

  it("falha na leitura do pedido LANÇA, o pedido ausente LANÇA, e o corte sem a linha do SKU também", async () => {
    await expect(processa({ saleMovements: ESTORNADA, orderReadError: true, cutoffRows: PLANILHA_2 })).rejects.toThrow(
      /falha ao ler a order.*boom/,
    );
    await expect(processa({ saleMovements: ESTORNADA, order: null, cutoffRows: PLANILHA_2 })).rejects.toThrow(/sem linha em orders/);
    await expect(processa({ saleMovements: ESTORNADA, order: CANCELADO_ANTES, cutoffRows: [] })).rejects.toThrow(
      /nao devolveu o corte do SKU sku-a/,
    );
  });

  it("estorno gravado com chave fora do formato LANÇA na leitura", async () => {
    await expect(
      processa({
        saleMovements: [
          { sku_id: "sku-a", qty_delta: -1, idempotency_key: VENDA },
          { sku_id: "sku-a", qty_delta: 1, idempotency_key: `estorno-pre-captura:${VENDA}`, movement_type: "ESTORNO_PRE_CAPTURA" },
        ],
        order: CANCELADO_ANTES,
        cutoffRows: PLANILHA_2,
      }),
    ).rejects.toThrow();
  });
});

/**
 * D-352 — devolucao de pedido entregue pelo Full nao repoe a loja.
 *
 * O produto volta para o galpao do Mercado Livre. O saldo LOCAL nunca perdeu a
 * unidade, entao nada volta para ele — o que sai e o par que faltava a venda.
 */
describe("processClaimReturn — pedido do Full (D-352)", () => {
  const VENDA = `venda:${String(ORDER_ID)}:0`;
  const PEDIDO_FULL = { ...PEDIDO_PADRAO, logistic_type: "fulfillment" };

  function processa(options: FakeDbOptions, rpcCalls: string[] = []) {
    const captured: Captured = { movements: [], events: [], supportCases: [] };
    const db = fakeDb(options, captured, rpcCalls);
    const { client } = fakeMercadoLivre({});

    return {
      captured,
      resultado: processClaimReturn(
        { db, mercadoLivre: client },
        { organizationId: ORGANIZATION_ID, mlAccountId: ML_ACCOUNT_ID },
        "token",
        CLAIM_ID,
        NOW,
        logger,
      ),
    };
  }

  it("devolucao total: nenhum DEVOLUCAO_ML, e o ESTORNO_FULL que faltava — com a origem do PEDIDO", async () => {
    const { captured, resultado } = processa({ order: PEDIDO_FULL });

    await resultado;

    expect(captured.movements).toEqual([
      expect.objectContaining({
        movement_type: "ESTORNO_FULL",
        qty_delta: 1,
        sku_id: "sku-a",
        idempotency_key: `estorno:${VENDA}`,
        // A origem e o PEDIDO, e nao o claim: e uma venda que esta sendo
        // estornada, e e por `source_type = 'ORDER'` que ela sera achada depois.
        source_type: "ORDER",
        source_id: String(ORDER_ID),
        // Espelha o instante da VENDA gravada, nao o da devolucao.
        occurred_at: GRAVADO_EM,
        location_kind: "LOCAL",
      }),
    ]);
  });

  it("contraprova FORA do Full: a mesma devolucao grava DEVOLUCAO_ML, com a origem do CLAIM", async () => {
    const { captured, resultado } = processa({ order: PEDIDO_PADRAO });

    await resultado;

    expect(captured.movements).toEqual([
      expect.objectContaining({ movement_type: "DEVOLUCAO_ML", qty_delta: 1, source_type: "CLAIM", source_id: CLAIM_ID }),
    ]);
  });

  it("venda JA estornada: nada e gravado — nem reversao, nem um segundo par", async () => {
    const { captured, resultado } = processa({
      order: PEDIDO_FULL,
      saleMovements: [
        { sku_id: "sku-a", qty_delta: -1, idempotency_key: VENDA },
        { sku_id: "sku-a", qty_delta: 1, idempotency_key: `estorno:${VENDA}`, movement_type: "ESTORNO_FULL" },
      ],
    });

    await resultado;

    expect(captured.movements).toEqual([]);
  });

  it("devolucao PARCIAL de pedido do Full: nada no saldo, e o evento nao pede gente", async () => {
    const captured: Captured = { movements: [], events: [], supportCases: [] };
    const db = fakeDb({ order: PEDIDO_FULL }, captured);
    const { client } = fakeMercadoLivre({ claimReturn: returnPayload({ total_quantity: "5.0", return_quantity: "2.0" }) });

    await processClaimReturn(
      { db, mercadoLivre: client },
      { organizationId: ORGANIZATION_ID, mlAccountId: ML_ACCOUNT_ID },
      "token",
      CLAIM_ID,
      NOW,
      logger,
    );

    expect(captured.movements.filter((m) => m.movement_type === "DEVOLUCAO_ML")).toEqual([]);
    expect(captured.events[0]?.after).toMatchObject({ fullLogistic: true, needsManualReview: false });
  });

  it("CANCELAMENTO_ML gravado antes de o sinal chegar: o par sai E a reversao e anulada", async () => {
    const { captured, resultado } = processa({
      order: PEDIDO_FULL,
      saleMovements: [
        { sku_id: "sku-a", qty_delta: -1, idempotency_key: VENDA },
        { sku_id: "sku-a", qty_delta: 1, idempotency_key: `cancelamento:${VENDA}`, movement_type: "CANCELAMENTO_ML" },
      ],
    });

    await resultado;

    expect(captured.movements.map((m) => [m.movement_type, m.qty_delta, m.idempotency_key])).toEqual([
      ["ESTORNO_FULL", 1, `estorno:${VENDA}`],
      ["ESTORNO_REVERSAO_EXCEDENTE", -1, `estorno:cancelamento:${VENDA}`],
    ]);
    // -1 (venda) +1 (cancelamento gravado) +1 (estorno) -1 (anulacao) = 0.
    const gravado = -1 + 1;
    const novo = captured.movements.reduce((total, m) => total + Number(m.qty_delta), 0);

    expect(gravado + novo).toBe(0);
  });

  it("KIT do Full: um ESTORNO_FULL por componente, nenhuma reversao", async () => {
    const { captured, resultado } = processa({
      order: PEDIDO_FULL,
      saleMovements: [
        { sku_id: "comp-1", qty_delta: -2, idempotency_key: `${VENDA}:comp-1` },
        { sku_id: "comp-2", qty_delta: -1, idempotency_key: `${VENDA}:comp-2` },
      ],
    });

    await resultado;

    expect(captured.movements.map((m) => [m.movement_type, m.sku_id, m.qty_delta])).toEqual([
      ["ESTORNO_FULL", "comp-1", 2],
      ["ESTORNO_FULL", "comp-2", 1],
    ]);
  });

  it("movimento gravado sem occurred_at legivel LANCA — o par do Full precisa saber de que lado do corte cair", async () => {
    const { resultado } = processa({
      order: PEDIDO_FULL,
      saleMovements: [{ sku_id: "sku-a", qty_delta: -1, idempotency_key: VENDA, occurred_at: "nao e data" }],
    });

    await expect(resultado).rejects.toThrow(/sem occurred_at legivel/);
  });
});
