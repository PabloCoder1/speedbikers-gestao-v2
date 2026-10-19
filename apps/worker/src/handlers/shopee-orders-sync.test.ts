import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { createShopeeClient } from "@sb/shopee";
import { describe, expect, it } from "vitest";

import type { EnqueueRequest } from "../enqueue.js";
import type { ShopeeOrdersSyncDeps } from "./shopee-orders-sync.js";
import { createShopeeOrdersSyncHandler } from "./shopee-orders-sync.js";

const KEY = randomBytes(32);
const NOW = new Date("2026-10-13T15:00:00.000Z");
const AGORA_S = Math.floor(NOW.getTime() / 1000);
const LOJA_ID = "aaaaaaaa-0000-4000-8000-0000000000aa";
const ORG = "11111111-0000-4000-8000-000000000001";

const ENVELOPE = {
  jobType: "shopee.orders.sync",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b99",
  organizationId: ORG,
  dedupeKey: "shopee-orders:x",
  attempt: 1,
  enqueuedAt: NOW.toISOString(),
};

interface Loja {
  id: string;
  organization_id: string;
  environment: string;
  shop_id: number;
  status: string;
  orders_synced_until: string | null;
}

interface PedidoGravado extends Record<string, unknown> {
  order_sn: string;
  itens: Record<string, unknown>[];
}

/**
 * Banco falso: a loja e a credencial por `select`; a gravação do lote e o
 * marco por RPC (D-432). `gravaAte` diz quantos pedidos o banco aceita por
 * lote (os outros seriam leitura mais velha que a guardada); `erroNaGravacao`
 * faz a RPC do lote falhar.
 */
function fakeDb(loja: Loja | null, opcoes: Opcoes = {}) {
  const gravado = {
    marcos: [] as unknown[],
    lotes: [] as { loja: unknown; pedidos: PedidoGravado[]; syncedAt: unknown }[],
    // D-481: a ordem entre travar, soltar e enfileirar.
    eventos: [] as string[],
  };

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
    rpc: (nome: string, args: Record<string, unknown>) => {
      if (nome === "shopee_orders_sync_lock") {
        gravado.eventos.push("trava");

        return Promise.resolve({ data: opcoes.travada !== true, error: null });
      }

      if (nome === "shopee_upsert_orders") {
        if (opcoes.erroNaGravacao !== undefined) {
          return Promise.resolve({ data: null, error: { message: opcoes.erroNaGravacao } });
        }

        const pedidos = args.p_pedidos as PedidoGravado[];

        gravado.lotes.push({ loja: args.p_shopee_shop_id, pedidos, syncedAt: args.p_synced_at });

        return Promise.resolve({ data: Math.min(pedidos.length, opcoes.gravaAte ?? pedidos.length), error: null });
      }

      if (nome === "shopee_advance_orders_synced_until") {
        if (opcoes.lancaNoMarco === true) {
          return Promise.reject(new Error("rede caiu"));
        }

        gravado.marcos.push(args.p_until);

        return Promise.resolve({ data: args.p_until, error: null });
      }

      throw new Error(`rpc inesperada: ${nome}`);
    },
    from: (table: string) => ({
      select: () => leitura({ data: table === "shopee_shops" ? loja : credencial, error: null }),
      update: (valores: Record<string, unknown>) => ({
        eq: () => {
          if (table === "shopee_shops" && "orders_sync_locked_until" in valores && valores.orders_sync_locked_until === null) {
            gravado.eventos.push("solta");
          }

          return Promise.resolve({ error: null });
        },
      }),
    }),
  } as unknown as ShopeeOrdersSyncDeps["db"];

  return { db, gravado };
}

function pedido(sn: string) {
  return {
    order_sn: sn,
    order_status: "COMPLETED",
    currency: "BRL",
    total_amount: 120.5,
    create_time: AGORA_S - 86400,
    update_time: AGORA_S - 3600,
    pay_time: AGORA_S - 86000,
    fulfillment_flag: sn === "A1" ? "fulfilled_by_shopee" : "",
    item_list: [
      { item_id: 1, item_name: "Bau", item_sku: "BAU05", model_id: 0, model_sku: "", model_quantity_purchased: 1, model_original_price: 130, model_discounted_price: 120.5 },
      { item_id: 2, item_sku: "", model_id: 77, model_sku: "BAU05-P", model_quantity_purchased: 2 },
    ],
  };
}

/** Shopee falsa: a lista em páginas pelo cursor, o detalhe do que foi pedido. */
function fakeShopee(opcoes: { paginas: string[][]; erroNaLista?: string }) {
  const listas: URLSearchParams[] = [];
  const detalhes: string[][] = [];
  const fetchImpl = (url: URL) => {
    if (url.pathname === "/api/v2/order/get_order_list") {
      listas.push(url.searchParams);

      if (opcoes.erroNaLista !== undefined) {
        return Promise.resolve(new Response(JSON.stringify({ error: opcoes.erroNaLista, message: "x" }), { status: 200 }));
      }

      const indice = Number(url.searchParams.get("cursor") ?? "0");
      const mais = indice + 1 < opcoes.paginas.length;

      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: "",
            response: {
              more: mais,
              next_cursor: mais ? String(indice + 1) : "",
              order_list: (opcoes.paginas[indice] ?? []).map((order_sn) => ({ order_sn })),
            },
          }),
          { status: 200 },
        ),
      );
    }

    const sns = (url.searchParams.get("order_sn_list") ?? "").split(",");

    detalhes.push(sns);

    return Promise.resolve(
      new Response(JSON.stringify({ error: "", response: { order_list: sns.map(pedido) } }), { status: 200 }),
    );
  };

  return {
    client: createShopeeClient({
      environment: "sandbox",
      partnerId: 1248019,
      partnerKey: "chave-de-teste-nao-real",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    }),
    listas,
    detalhes,
  };
}

interface Opcoes {
  gravaAte?: number;
  erroNaGravacao?: string;
  /** D-481: outra execução segura a trava da loja. */
  travada?: boolean;
  /** D-481: o avanço do marco LANÇA (rede), em vez de devolver erro. */
  lancaNoMarco?: boolean;
}

function rodar(loja: Loja | null, shopee: ReturnType<typeof fakeShopee>, opcoes: Opcoes = {}, eventos?: string[]) {
  const { db, gravado } = fakeDb(loja, opcoes);

  if (eventos !== undefined) gravado.eventos = eventos;
  const enfileirados: EnqueueRequest[] = [];
  const handler = createShopeeOrdersSyncHandler({
    db,
    client: shopee.client,
    encryptionKey: KEY,
    now: () => NOW,
    enqueuer: {
      enqueue: (request) => {
        enfileirados.push(request);
        gravado.eventos.push("enfileira");

        return Promise.resolve({ deduplicated: false });
      },
    } as ShopeeOrdersSyncDeps["enqueuer"],
  });

  return handler(ENVELOPE, {
    logger: createLogger({}, { sink: () => undefined }),
    payload: { shopeeShopId: LOJA_ID },
  }).then((outcome) => ({ outcome, gravado, enfileirados }));
}

const LOJA: Loja = {
  id: LOJA_ID,
  organization_id: ORG,
  environment: "sandbox",
  shop_id: 54804,
  status: "CONNECTED",
  orders_synced_until: null,
};

describe("shopee.orders.sync (D-426)", () => {
  it("primeira leitura: começa 90 dias atrás, numa janela de 15 dias, e enfileira a próxima", async () => {
    const shopee = fakeShopee({ paginas: [["A1"]] });
    const { outcome, gravado, enfileirados } = await rodar(LOJA, shopee);

    const de = AGORA_S - 90 * 86400;

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(shopee.listas[0]?.get("time_range_field")).toBe("update_time");
    expect(shopee.listas[0]?.get("time_from")).toBe(String(de));
    expect(shopee.listas[0]?.get("time_to")).toBe(String(de + 15 * 86400));
    expect(gravado.marcos).toEqual([new Date((de + 15 * 86400) * 1000).toISOString()]);
    expect(enfileirados).toEqual([
      {
        jobType: "shopee.orders.sync",
        organizationId: ORG,
        dedupeKey: `shopee-orders:${LOJA_ID}:${String(de + 15 * 86400)}`,
        queue: "backfill",
        payload: { shopeeShopId: LOJA_ID },
      },
    ]);
  });

  it("com marco: lê de 10 minutos antes dele até agora e, alcançado agora, enfileira o financeiro; grava pedido e itens", async () => {
    const marco = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    const shopee = fakeShopee({ paginas: [["A1", "A2"]] });
    const { outcome, gravado, enfileirados } = await rodar({ ...LOJA, orders_synced_until: marco }, shopee);

    expect(outcome).toEqual({ status: "done", processed: 2 });
    expect(shopee.listas[0]?.get("time_from")).toBe(String(Math.floor(new Date(marco).getTime() / 1000) - 600));
    expect(shopee.listas[0]?.get("time_to")).toBe(String(AGORA_S));
    // Sem nova janela de pedidos; o financeiro (D-427), as devoluções (D-447), o Ads (D-449) e os repasses (D-451) vêm atrás.
    expect(enfileirados).toEqual([
      {
        jobType: "shopee.order-financials.sync",
        organizationId: ORG,
        dedupeKey: `shopee-financials:${LOJA_ID}:${String(AGORA_S)}`,
        queue: "backfill",
        payload: { shopeeShopId: LOJA_ID },
      },
      {
        jobType: "shopee.returns.sync",
        organizationId: ORG,
        dedupeKey: `shopee-returns-ciclo:${LOJA_ID}:${String(AGORA_S)}`,
        queue: "backfill",
        payload: { shopeeShopId: LOJA_ID },
      },
      {
        jobType: "shopee.ads.sync",
        organizationId: ORG,
        dedupeKey: `shopee-ads:${LOJA_ID}:${String(AGORA_S)}`,
        queue: "backfill",
        payload: { shopeeShopId: LOJA_ID },
      },
      {
        jobType: "shopee.escrow-releases.sync",
        organizationId: ORG,
        dedupeKey: `shopee-escrow-releases-ciclo:${LOJA_ID}:${String(AGORA_S)}`,
        queue: "backfill",
        payload: { shopeeShopId: LOJA_ID },
      },
    ]);
    expect(gravado.marcos).toEqual([NOW.toISOString()]);
    // D-432: o lote inteiro numa RPC (pedido, itens substituídos e SKU, numa
    // transação); a organização vem da loja, no banco.
    expect(gravado.lotes).toHaveLength(1);
    expect(gravado.lotes[0]?.loja).toBe(LOJA_ID);
    expect(gravado.lotes[0]?.syncedAt).toBe(NOW.toISOString());
    expect(gravado.lotes[0]?.pedidos.map((p) => p.order_sn)).toEqual(["A1", "A2"]);
    expect(gravado.lotes[0]?.pedidos[0]).toMatchObject({
      order_sn: "A1",
      order_status: "COMPLETED",
      total_amount: 120.5,
      shopee_updated_at: new Date((AGORA_S - 3600) * 1000).toISOString(),
      fulfillment_flag: "fulfilled_by_shopee",
    });
    // D-495: o vazio vira nulo, como os outros textos do pedido.
    expect(gravado.lotes[0]?.pedidos[1]).toMatchObject({ order_sn: "A2", fulfillment_flag: null });
    expect(gravado.lotes[0]?.pedidos[0]).not.toHaveProperty("organization_id");
    expect(gravado.lotes[0]?.pedidos[0]?.itens).toEqual([
      expect.objectContaining({ position: 0, item_sku: "BAU05", model_id: null, model_sku: null, quantity: 1, discounted_price: 120.5 }),
      expect.objectContaining({ position: 1, item_sku: null, model_id: 77, model_sku: "BAU05-P", quantity: 2 }),
    ]);
  });

  it("segue o cursor da lista e lê o detalhe em lotes de 50", async () => {
    const pagina = (de: number) => Array.from({ length: 30 }, (_, i) => `S${String(de + i)}`);
    const shopee = fakeShopee({ paginas: [pagina(0), pagina(30), pagina(60)] });

    const { outcome } = await rodar({ ...LOJA, orders_synced_until: NOW.toISOString() }, shopee);

    expect(outcome).toEqual({ status: "done", processed: 90 });
    expect(shopee.listas.map((l) => l.get("cursor"))).toEqual([null, "1", "2"]);
    expect(shopee.detalhes.map((d) => d.length)).toEqual([50, 40]);
  });

  it("erro da Shopee na lista: falha, e o marco não anda", async () => {
    const passageiro = await rodar(LOJA, fakeShopee({ paginas: [], erroNaLista: "error_server" }));
    const definitivo = await rodar(LOJA, fakeShopee({ paginas: [], erroNaLista: "error_param" }));

    expect(passageiro.outcome).toMatchObject({ status: "failed", retryable: true });
    expect(definitivo.outcome).toMatchObject({ status: "failed", retryable: false });
    expect(passageiro.gravado.marcos).toEqual([]);
    expect(definitivo.gravado.marcos).toEqual([]);
  });

  it("D-432: leitura mais velha que a guardada é ignorada pelo banco e não conta como gravada; o marco anda", async () => {
    const marco = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    const { outcome, gravado } = await rodar(
      { ...LOJA, orders_synced_until: marco },
      fakeShopee({ paginas: [["A1", "A2", "A3"]] }),
      { gravaAte: 1 },
    );

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(gravado.marcos).toEqual([NOW.toISOString()]);
  });

  it("D-432: falha ao gravar o lote não avança o marco, e a tarefa se repete", async () => {
    const { outcome, gravado } = await rodar(LOJA, fakeShopee({ paginas: [["A1"]] }), { erroNaGravacao: "deadlock" });

    expect(outcome).toEqual({ status: "failed", retryable: true, reason: "falha ao gravar pedidos: deadlock" });
    expect(gravado.marcos).toEqual([]);
  });

  it("D-432: janela acima do teto de páginas falha SEM repetir (repetir bateria no mesmo teto)", async () => {
    const paginas = Array.from({ length: 201 }, (): string[] => []);
    const { outcome, gravado } = await rodar(LOJA, fakeShopee({ paginas }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(gravado.lotes).toEqual([]);
    expect(gravado.marcos).toEqual([]);
  });

  it("D-481: outra leitura da loja em andamento: encerra sem erro, sem chamar a Shopee e sem enfileirar", async () => {
    const shopee = fakeShopee({ paginas: [["A1"]] });
    const { outcome, gravado, enfileirados } = await rodar(LOJA, shopee, { travada: true });

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(shopee.listas).toEqual([]);
    expect(enfileirados).toEqual([]);
    expect(gravado.marcos).toEqual([]);
    // Quem não pegou a trava não a solta (seria soltar a de outra execução).
    expect(gravado.eventos).toEqual(["trava"]);
  });

  it("D-481: solta a trava ANTES de enfileirar a janela seguinte (a continuação a acharia presa)", async () => {
    const { outcome, gravado } = await rodar(LOJA, fakeShopee({ paginas: [["A1"]] }));

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(gravado.eventos).toEqual(["trava", "solta", "enfileira"]);
  });

  it("D-481: falha no meio da janela também solta a trava, e nada é enfileirado", async () => {
    const { outcome, gravado, enfileirados } = await rodar(LOJA, fakeShopee({ paginas: [["A1"]], erroNaLista: "error_param" }));

    expect(outcome).toMatchObject({ status: "failed" });
    expect(enfileirados).toEqual([]);
    expect(gravado.eventos).toEqual(["trava", "solta"]);
  });

  it("D-481: exceção no meio da janela (rede) solta a trava antes de a tarefa falhar", async () => {
    const eventos: string[] = [];

    await expect(rodar(LOJA, fakeShopee({ paginas: [["A1"]] }), { lancaNoMarco: true }, eventos)).rejects.toThrow("rede caiu");
    expect(eventos).toEqual(["trava", "solta"]);
  });

  it("loja em erro, de outro ambiente ou inexistente: pula, sem chamar a Shopee", async () => {
    for (const loja of [{ ...LOJA, status: "ERROR" }, { ...LOJA, environment: "live" }, null]) {
      const shopee = fakeShopee({ paginas: [["A1"]] });
      const { outcome } = await rodar(loja, shopee);

      expect(outcome).toEqual({ status: "done", processed: 0 });
      expect(shopee.listas).toEqual([]);
    }
  });
});
