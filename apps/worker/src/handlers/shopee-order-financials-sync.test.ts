import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { createShopeeClient } from "@sb/shopee";
import { describe, expect, it } from "vitest";

import type { EnqueueRequest } from "../enqueue.js";
import type { ShopeeOrderFinancialsSyncDeps } from "./shopee-order-financials-sync.js";
import { FINANCEIRO_POR_EXECUCAO, createShopeeOrderFinancialsSyncHandler } from "./shopee-order-financials-sync.js";

const KEY = randomBytes(32);
const NOW = new Date("2026-10-13T15:00:00.000Z");
const LOJA_ID = "aaaaaaaa-0000-4000-8000-0000000000aa";
const ORG = "11111111-0000-4000-8000-000000000001";

const ENVELOPE = {
  jobType: "shopee.order-financials.sync",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b98",
  organizationId: ORG,
  dedupeKey: "shopee-financials:x",
  attempt: 1,
  enqueuedAt: NOW.toISOString(),
};

const LOJA = { id: LOJA_ID, organization_id: ORG, environment: "sandbox", shop_id: 54804, status: "CONNECTED" };

function fakeDb(opcoes: { loja?: typeof LOJA | null; pendentes: string[] }) {
  const gravados: { orderSn: string; row: Record<string, unknown> }[] = [];
  const rpcs: unknown[] = [];

  function leitura(result: unknown) {
    const self: Record<string, unknown> = {};

    self.select = () => self;
    self.eq = () => self;
    self.maybeSingle = () => Promise.resolve(result);

    return self;
  }

  const credencial = {
    access_token_ciphertext: encryptToken("acesso-valido", KEY),
    access_token_expires_at: new Date(NOW.getTime() + 3 * 3_600_000).toISOString(),
  };

  const db = {
    rpc: (nome: string, args: unknown) => {
      rpcs.push({ nome, args });

      return Promise.resolve({ data: opcoes.pendentes.map((order_sn) => ({ order_sn })), error: null });
    },
    from: (table: string) => ({
      select: () =>
        leitura({ data: table === "shopee_shops" ? (opcoes.loja === undefined ? LOJA : opcoes.loja) : credencial, error: null }),
      update: (row: Record<string, unknown>) => {
        const filtros: Record<string, unknown> = {};
        const self = {
          eq: (coluna: string, valor: unknown) => {
            filtros[coluna] = valor;

            return self;
          },
          then: (resolve: (value: unknown) => unknown) => {
            if (table === "shopee_orders") gravados.push({ orderSn: String(filtros.order_sn), row });

            return Promise.resolve({ error: null }).then(resolve);
          },
        };

        return self;
      },
    }),
  } as unknown as ShopeeOrderFinancialsSyncDeps["db"];

  return { db, gravados, rpcs };
}

/** Shopee falsa: um financeiro por pedido, ou o erro pedido para aquele pedido. */
function fakeShopee(erros: Record<string, string> = {}) {
  const pedidos: string[] = [];
  const fetchImpl = (url: URL) => {
    const sn = url.searchParams.get("order_sn") ?? "";

    pedidos.push(sn);

    const erro = erros[sn];
    const corpo =
      erro === undefined
        ? {
            error: "",
            response: {
              order_sn: sn,
              buyer_user_name: "comprador",
              return_order_sn_list: [],
              order_income: { escrow_amount: 81.4, commission_fee: 16.1, service_fee: 4, final_shipping_fee: -12.5 },
            },
          }
        : { error: erro, message: "x" };

    return Promise.resolve(new Response(JSON.stringify(corpo), { status: 200 }));
  };

  return {
    client: createShopeeClient({
      environment: "sandbox",
      partnerId: 1248019,
      partnerKey: "chave-de-teste-nao-real",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    }),
    pedidos,
  };
}

async function rodar(db: ReturnType<typeof fakeDb>, shopee: ReturnType<typeof fakeShopee>) {
  const enfileirados: EnqueueRequest[] = [];
  const handler = createShopeeOrderFinancialsSyncHandler({
    db: db.db,
    client: shopee.client,
    encryptionKey: KEY,
    now: () => NOW,
    enqueuer: {
      enqueue: (request) => {
        enfileirados.push(request);

        return Promise.resolve({ deduplicated: false });
      },
    } as ShopeeOrderFinancialsSyncDeps["enqueuer"],
  });

  const outcome = await handler(ENVELOPE, {
    logger: createLogger({}, { sink: () => undefined }),
    payload: { shopeeShopId: LOJA_ID },
  });

  return { outcome, enfileirados };
}

describe("shopee.order-financials.sync (D-427)", () => {
  it("lê o financeiro de cada pedido pendente e grava as colunas, o order_income e a hora — nada do comprador", async () => {
    const db = fakeDb({ pendentes: ["A1", "A2"] });
    const shopee = fakeShopee();

    const { outcome, enfileirados } = await rodar(db, shopee);

    expect(outcome).toEqual({ status: "done", processed: 2 });
    expect(db.rpcs).toEqual([
      { nome: "shopee_orders_financials_pending", args: { p_shopee_shop_id: LOJA_ID, p_limit: FINANCEIRO_POR_EXECUCAO } },
    ]);
    expect(shopee.pedidos).toEqual(["A1", "A2"]);
    expect(db.gravados[0]).toEqual({
      orderSn: "A1",
      row: expect.objectContaining({
        escrow_amount: 81.4,
        commission_fee: 16.1,
        service_fee: 4,
        final_shipping_fee: -12.5,
        // Ausente na resposta: nulo, nunca zero.
        net_commission_fee: null,
        actual_shipping_fee: null,
        return_order_sns: [],
        order_income: { escrow_amount: 81.4, commission_fee: 16.1, service_fee: 4, final_shipping_fee: -12.5 },
        financials_synced_at: NOW.toISOString(),
      }) as unknown,
    });
    expect(JSON.stringify(db.gravados)).not.toContain("comprador");
    expect(enfileirados).toEqual([]);
  });

  it("pedido que a Shopee não acha: marcado como lido, sem tocar no financeiro guardado", async () => {
    const db = fakeDb({ pendentes: ["A1", "A2"] });

    const { outcome } = await rodar(db, fakeShopee({ A1: "order_not_found" }));

    expect(outcome).toEqual({ status: "done", processed: 2 });
    expect(db.gravados[0]).toEqual({ orderSn: "A1", row: { financials_synced_at: NOW.toISOString() } });
    expect(db.gravados[1]?.row).toMatchObject({ escrow_amount: 81.4 });
  });

  it("erro da Shopee no meio: o que já foi lido fica gravado, e a falha diz se repete", async () => {
    const passageiro = fakeDb({ pendentes: ["A1", "A2", "A3"] });
    const definitivo = fakeDb({ pendentes: ["A1"] });

    const a = await rodar(passageiro, fakeShopee({ A2: "error_server" }));
    const b = await rodar(definitivo, fakeShopee({ A1: "error_param" }));

    expect(a.outcome).toMatchObject({ status: "failed", retryable: true });
    expect(passageiro.gravados.map((g) => g.orderSn)).toEqual(["A1"]);
    expect(b.outcome).toMatchObject({ status: "failed", retryable: false });
  });

  it("lote cheio enfileira a continuação; nada pendente termina sem chamar a Shopee", async () => {
    const cheio = fakeDb({ pendentes: Array.from({ length: FINANCEIRO_POR_EXECUCAO }, (_, i) => `S${String(i)}`) });
    const vazio = fakeDb({ pendentes: [] });
    const shopeeVazio = fakeShopee();

    const a = await rodar(cheio, fakeShopee());
    const b = await rodar(vazio, shopeeVazio);

    expect(a.enfileirados).toEqual([
      {
        jobType: "shopee.order-financials.sync",
        organizationId: ORG,
        dedupeKey: `shopee-financials:${LOJA_ID}:${String(NOW.getTime() / 1000)}`,
        queue: "backfill",
        payload: { shopeeShopId: LOJA_ID },
      },
    ]);
    expect(b.outcome).toEqual({ status: "done", processed: 0 });
    expect(shopeeVazio.pedidos).toEqual([]);
  });

  it("loja em erro, de outro ambiente ou inexistente: pula, sem chamar a Shopee", async () => {
    for (const loja of [{ ...LOJA, status: "ERROR" }, { ...LOJA, environment: "live" }, null]) {
      const db = fakeDb({ loja, pendentes: ["A1"] });
      const shopee = fakeShopee();

      expect((await rodar(db, shopee)).outcome).toEqual({ status: "done", processed: 0 });
      expect(shopee.pedidos).toEqual([]);
      expect(db.rpcs).toEqual([]);
    }
  });
});
