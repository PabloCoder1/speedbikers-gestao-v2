import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { createShopeeClient } from "@sb/shopee";
import { describe, expect, it } from "vitest";

import type { EnqueueRequest } from "../enqueue.js";
import type { ShopeeReturnsSyncDeps } from "./shopee-returns-sync.js";
import { createShopeeReturnsSyncHandler } from "./shopee-returns-sync.js";

const KEY = randomBytes(32);
const NOW = new Date("2026-10-14T15:00:00.000Z");
const AGORA_S = Math.floor(NOW.getTime() / 1000);
const LOJA_ID = "aaaaaaaa-0000-4000-8000-0000000000aa";
const ORG = "11111111-0000-4000-8000-000000000001";

const ENVELOPE = {
  jobType: "shopee.returns.sync",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b98",
  organizationId: ORG,
  dedupeKey: "shopee-returns:x",
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
  returns_synced_until: string | null;
}

/** Banco falso: a loja (com o marco das devoluções) e a credencial por `select`; o lote e o marco por RPC. */
function fakeDb(loja: Loja | null, opcoes: { erroNaGravacao?: string } = {}) {
  const gravado = { marcos: [] as unknown[], lotes: [] as Record<string, unknown>[][] };

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
      if (nome === "shopee_upsert_returns") {
        if (opcoes.erroNaGravacao !== undefined) {
          return Promise.resolve({ data: null, error: { message: opcoes.erroNaGravacao } });
        }

        const lote = args.p_devolucoes as Record<string, unknown>[];

        gravado.lotes.push(lote);

        return Promise.resolve({ data: lote.length, error: null });
      }

      if (nome === "shopee_advance_returns_synced_until") {
        gravado.marcos.push(args.p_until);

        return Promise.resolve({ data: args.p_until, error: null });
      }

      throw new Error(`rpc inesperada: ${nome}`);
    },
    from: (table: string) => ({
      select: () => leitura({ data: table === "shopee_shops" ? loja : credencial, error: null }),
    }),
  } as unknown as ShopeeReturnsSyncDeps["db"];

  return { db, gravado };
}

function devolucao(sn: string, solucao: number, updateTime = AGORA_S - 3600) {
  return {
    return_sn: sn,
    order_sn: `P-${sn}`,
    status: "REQUESTED",
    reason: "ITEM_DAMAGED",
    reassessed_request_reason: "NONE",
    text_reason: "texto do comprador",
    refund_amount: 59.9,
    currency: "BRL",
    create_time: AGORA_S - 86400,
    update_time: updateTime,
    due_date: AGORA_S + 86400,
    tracking_number: "",
    needs_logistics: solucao === 0,
    return_solution: solucao,
    user: { username: "comprador", email: "x@y", portrait: "z" },
    item: [{ item_id: 9, model_id: 0, name: "Bau", amount: 1, item_price: 59.9, item_sku: "BAU05", variation_sku: "" }],
  };
}

/** Shopee falsa: as páginas por `page_no`. */
function fakeShopee(opcoes: { paginas: unknown[][]; repete?: boolean; erro?: string }) {
  const listas: URLSearchParams[] = [];
  const fetchImpl = (url: URL) => {
    listas.push(url.searchParams);

    if (opcoes.erro !== undefined) {
      return Promise.resolve(new Response(JSON.stringify({ error: opcoes.erro, message: "x" }), { status: 200 }));
    }

    const indice = opcoes.repete === true ? 0 : Number(url.searchParams.get("page_no") ?? "0");
    const mais = opcoes.repete === true || indice + 1 < opcoes.paginas.length;

    return Promise.resolve(
      new Response(JSON.stringify({ error: "", response: { more: mais, return: opcoes.paginas[indice] ?? [] } }), { status: 200 }),
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
  };
}

function rodar(loja: Loja | null, shopee: ReturnType<typeof fakeShopee>, opcoes: { erroNaGravacao?: string } = {}) {
  const { db, gravado } = fakeDb(loja, opcoes);
  const enfileirados: EnqueueRequest[] = [];
  const handler = createShopeeReturnsSyncHandler({
    db,
    client: shopee.client,
    encryptionKey: KEY,
    now: () => NOW,
    enqueuer: {
      enqueue: (request) => {
        enfileirados.push(request);

        return Promise.resolve({ deduplicated: false });
      },
    } as ShopeeReturnsSyncDeps["enqueuer"],
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
  returns_synced_until: null,
};

describe("shopee.returns.sync (D-447)", () => {
  it("primeira leitura: começa 90 dias atrás, numa janela de 15 dias de update_time, e enfileira a próxima", async () => {
    const shopee = fakeShopee({ paginas: [[devolucao("R1", 0)]] });
    const { outcome, gravado, enfileirados } = await rodar(LOJA, shopee);
    const de = AGORA_S - 90 * 86400;

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(shopee.listas[0]?.get("page_no")).toBe("0");
    expect(shopee.listas[0]?.get("update_time_from")).toBe(String(de));
    expect(shopee.listas[0]?.get("update_time_to")).toBe(String(de + 15 * 86400));
    expect(gravado.marcos).toEqual([new Date((de + 15 * 86400) * 1000).toISOString()]);
    expect(enfileirados).toEqual([
      {
        jobType: "shopee.returns.sync",
        organizationId: ORG,
        dedupeKey: `shopee-returns:${LOJA_ID}:${String(de + 15 * 86400)}`,
        queue: "backfill",
        payload: { shopeeShopId: LOJA_ID },
      },
    ]);
  });

  it("com marco: lê de 10 minutos antes até agora, página a página, grava normalizado e não enfileira nada", async () => {
    const marco = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    // A mesma devolução em duas páginas: vale a leitura mais nova.
    const shopee = fakeShopee({ paginas: [[devolucao("R1", 0, AGORA_S - 7200), devolucao("R2", 1)], [devolucao("R1", 0, AGORA_S - 60)]] });
    const { outcome, gravado, enfileirados } = await rodar({ ...LOJA, returns_synced_until: marco }, shopee);

    expect(outcome).toEqual({ status: "done", processed: 2 });
    expect(shopee.listas.map((l) => l.get("page_no"))).toEqual(["0", "1"]);
    expect(shopee.listas[0]?.get("update_time_from")).toBe(String(Math.floor(new Date(marco).getTime() / 1000) - 600));
    expect(shopee.listas[0]?.get("update_time_to")).toBe(String(AGORA_S));
    expect(enfileirados).toEqual([]);
    expect(gravado.marcos).toEqual([NOW.toISOString()]);

    const lote = gravado.lotes[0] ?? [];
    const r1 = lote.find((d) => d.return_sn === "R1");

    expect(r1).toMatchObject({
      order_sn: "P-R1",
      status: "REQUESTED",
      return_solution: "RETURN_REFUND",
      refund_amount: 59.9,
      // Vazio vira nulo.
      tracking_number: null,
      shopee_updated_at: new Date((AGORA_S - 60) * 1000).toISOString(),
      itens: [{ position: 0, item_id: 9, model_id: null, item_name: "Bau", item_sku: "BAU05", variation_sku: null, quantity: 1, item_price: 59.9 }],
    });
    expect(lote.find((d) => d.return_sn === "R2")).toMatchObject({ return_solution: "REFUND", needs_logistics: false });
    // Nada do comprador chega ao banco.
    expect(JSON.stringify(lote)).not.toMatch(/comprador|username|text_reason/);
  });

  it("página que só repete as anteriores enquanto há mais: para com o motivo, sem girar em falso", async () => {
    const shopee = fakeShopee({ paginas: [[devolucao("R1", 0)]], repete: true });
    const { outcome, gravado } = await rodar(LOJA, shopee);

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(outcome.status === "failed" ? outcome.reason : "").toMatch(/paginação fora do esperado/);
    expect(gravado.marcos).toEqual([]);
  });

  it("erro passageiro da Shopee e falha ao gravar repetem sem avançar o marco; loja desconectada encerra sem erro", async () => {
    const passageiro = await rodar(LOJA, fakeShopee({ paginas: [], erro: "error_server" }));

    expect(passageiro.outcome).toMatchObject({ status: "failed", retryable: true });
    expect(passageiro.gravado.marcos).toEqual([]);

    const gravacao = await rodar(LOJA, fakeShopee({ paginas: [[devolucao("R1", 0)]] }), { erroNaGravacao: "boom" });

    expect(gravacao.outcome).toMatchObject({ status: "failed", retryable: true });
    expect(gravacao.gravado.marcos).toEqual([]);

    const desconectada = await rodar({ ...LOJA, status: "DISCONNECTED" }, fakeShopee({ paginas: [] }));

    expect(desconectada.outcome).toEqual({ status: "done", processed: 0 });
  });
});
