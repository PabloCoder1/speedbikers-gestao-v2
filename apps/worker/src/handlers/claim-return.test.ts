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
  saleMovements?: { sku_id: string; qty_delta: number; idempotency_key: string }[];
  orderItemsError?: boolean;
  saleMovementsError?: boolean;
  /** D-104: força a projeção de atendimento a falhar, sem tocar no estoque. */
  supportError?: boolean;
}

interface Captured {
  movements: Record<string, unknown>[];
  events: Record<string, unknown>[];
  supportCases: Record<string, unknown>[];
}

function fakeDb(options: FakeDbOptions, captured: Captured): ProcessClaimReturnDeps["db"] {
  const position = "orderItemPosition" in options ? options.orderItemPosition : 0;
  const movements =
    options.saleMovements ?? [{ sku_id: "sku-a", qty_delta: -1, idempotency_key: `venda:${String(ORDER_ID)}:0` }];

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
                  eq: () =>
                    Promise.resolve(
                      options.saleMovementsError === true
                        ? { data: null, error: { code: "42P01", message: "boom" } }
                        : { data: movements, error: null },
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
          select: () => ({
            eq: function eq() {
              return this;
            },
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        };
      }

      if (table === "support_case_links") {
        return { insert: () => Promise.resolve({ data: null, error: null }) };
      }

      throw new Error(`tabela inesperada no fake: ${table}`);
    },
    rpc: () => Promise.resolve({ data: true, error: null }),
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
