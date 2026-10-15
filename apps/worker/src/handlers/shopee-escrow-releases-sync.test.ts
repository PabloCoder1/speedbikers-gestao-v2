import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { createShopeeClient } from "@sb/shopee";
import { describe, expect, it } from "vitest";

import type { EnqueueRequest } from "../enqueue.js";
import type { ShopeeEscrowReleasesSyncDeps } from "./shopee-escrow-releases-sync.js";
import { createShopeeEscrowReleasesSyncHandler } from "./shopee-escrow-releases-sync.js";

const KEY = randomBytes(32);
const NOW = new Date("2026-10-14T15:00:00.000Z");
const AGORA_S = Math.floor(NOW.getTime() / 1000);
const DIA_S = 24 * 3600;
const LOJA_ID = "aaaaaaaa-0000-4000-8000-0000000000aa";
const ORG = "11111111-0000-4000-8000-000000000001";

const ENVELOPE = {
  jobType: "shopee.escrow-releases.sync",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b98",
  organizationId: ORG,
  dedupeKey: "shopee-escrow-releases:x",
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
  escrow_releases_synced_until: string | null;
}

const LOJA: Loja = {
  id: LOJA_ID,
  organization_id: ORG,
  environment: "sandbox",
  shop_id: 54804,
  status: "CONNECTED",
  orders_synced_until: null,
  escrow_releases_synced_until: null,
};

function fakeDb(loja: Loja, opcoes: { erroNaGravacao?: string } = {}) {
  const chamadas: Record<string, unknown>[] = [];

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
      if (nome !== "shopee_upsert_escrow_releases") throw new Error(`rpc inesperada: ${nome}`);

      if (opcoes.erroNaGravacao !== undefined) {
        return Promise.resolve({ data: null, error: { message: opcoes.erroNaGravacao } });
      }

      chamadas.push(args);

      return Promise.resolve({ data: (args.p_repasses as unknown[]).length, error: null });
    },
    from: (table: string) => ({
      select: () => leitura({ data: table === "shopee_shops" ? loja : credencial, error: null }),
    }),
  } as unknown as ShopeeEscrowReleasesSyncDeps["db"];

  return { db, chamadas };
}

/** Cada chamada devolve a próxima resposta da lista (um corpo da Shopee). */
function fakeShopee(respostas: unknown[]) {
  const pedidos: URLSearchParams[] = [];
  const fetchImpl = (url: URL) => {
    pedidos.push(url.searchParams);
    const corpo = respostas[pedidos.length - 1] ?? { request_id: "r", response: { more: false } };

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

const pagina = (more: boolean, lista: { order_sn: string; payout_amount?: number; escrow_release_time: number }[]) => ({
  request_id: "r",
  response: { more, escrow_list: lista },
});

function rodar(loja: Loja, shopee: ReturnType<typeof fakeShopee>, opcoes: { erroNaGravacao?: string } = {}) {
  const { db, chamadas } = fakeDb(loja, opcoes);
  const enfileirados: EnqueueRequest[] = [];
  const handler = createShopeeEscrowReleasesSyncHandler({
    db,
    client: shopee.client,
    encryptionKey: KEY,
    now: () => NOW,
    enqueuer: {
      enqueue: (request: EnqueueRequest) => {
        enfileirados.push(request);

        return Promise.resolve({ deduplicated: false });
      },
    } as unknown as ShopeeEscrowReleasesSyncDeps["enqueuer"],
  });

  return handler(ENVELOPE, {
    logger: createLogger({}, { sink: () => undefined }),
    payload: { shopeeShopId: LOJA_ID },
  }).then((outcome) => ({ outcome, chamadas, enfileirados }));
}

describe("shopee.escrow-releases.sync (D-451)", () => {
  it("primeira leitura: 90 dias atrás, janela de 15 dias, todas as páginas numa gravação, e a próxima janela enfileirada", async () => {
    const deS = AGORA_S - 90 * DIA_S;
    const shopee = fakeShopee([
      pagina(true, [
        { order_sn: "A", payout_amount: 120.5, escrow_release_time: deS + 100 },
        { order_sn: "B", payout_amount: -3, escrow_release_time: deS + 200 },
      ]),
      pagina(false, [{ order_sn: "C", escrow_release_time: deS + 300 }]),
    ]);
    const { outcome, chamadas, enfileirados } = await rodar(LOJA, shopee);

    expect(outcome).toEqual({ status: "done", processed: 3 });
    expect(shopee.pedidos.map((p) => [p.get("release_time_from"), p.get("release_time_to"), p.get("page_no"), p.get("page_size")])).toEqual([
      [String(deS), String(deS + 15 * DIA_S), "1", "100"],
      [String(deS), String(deS + 15 * DIA_S), "2", "100"],
    ]);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toEqual({
      p_shopee_shop_id: LOJA_ID,
      p_repasses: [
        { order_sn: "A", released_at: new Date((deS + 100) * 1000).toISOString(), payout_amount: 120.5 },
        { order_sn: "B", released_at: new Date((deS + 200) * 1000).toISOString(), payout_amount: -3 },
        // Sem valor: a liberação é conhecida, o valor não.
        { order_sn: "C", released_at: new Date((deS + 300) * 1000).toISOString(), payout_amount: null },
      ],
      p_from: new Date(deS * 1000).toISOString(),
      p_until: new Date((deS + 15 * DIA_S) * 1000).toISOString(),
      p_synced_at: NOW.toISOString(),
    });
    expect(enfileirados).toEqual([
      {
        jobType: "shopee.escrow-releases.sync",
        organizationId: ORG,
        dedupeKey: `shopee-escrow-releases:${LOJA_ID}:${String(deS + 15 * DIA_S)}`,
        queue: "backfill",
        payload: { shopeeShopId: LOJA_ID },
      },
    ]);
  });

  it("com marco: lê de 10 minutos antes dele até agora e não enfileira; página que só repete para com o motivo", async () => {
    const marco = new Date((AGORA_S - 3600) * 1000).toISOString();
    const shopee = fakeShopee([pagina(false, [])]);
    const { outcome, chamadas, enfileirados } = await rodar({ ...LOJA, escrow_releases_synced_until: marco }, shopee);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(shopee.pedidos[0]?.get("release_time_from")).toBe(String(AGORA_S - 3600 - 600));
    expect(shopee.pedidos[0]?.get("release_time_to")).toBe(String(AGORA_S));
    expect(chamadas[0]).toMatchObject({ p_repasses: [], p_until: NOW.toISOString() });
    expect(enfileirados).toEqual([]);

    const repetida = [{ order_sn: "A", payout_amount: 1, escrow_release_time: AGORA_S - 100 }];
    const girando = await rodar({ ...LOJA, escrow_releases_synced_until: marco }, fakeShopee([pagina(true, repetida), pagina(true, repetida)]));

    expect(girando.outcome).toMatchObject({ status: "failed", retryable: false });
    expect(girando.chamadas).toEqual([]);
  });

  it("'nada liberado' é janela vazia; erro passageiro e falha ao gravar repetem, sem gravar", async () => {
    const vazio = await rodar(LOJA, fakeShopee([{ request_id: "r", error: "income_not_found", message: "The escrow income not found." }]));

    expect(vazio.outcome).toEqual({ status: "done", processed: 0 });
    expect(vazio.chamadas[0]).toMatchObject({ p_repasses: [] });

    const passageiro = await rodar(LOJA, fakeShopee([{ request_id: "r", error: "error_server", message: "Something wrong. Please try later." }]));

    expect(passageiro.outcome).toMatchObject({ status: "failed", retryable: true });
    expect(passageiro.chamadas).toEqual([]);

    const falhaDeLeitura = await rodar(LOJA, fakeShopee([{ request_id: "r", error: "error_data", message: "parse data failed" }]));

    expect(falhaDeLeitura.outcome).toMatchObject({ status: "failed" });
    expect(falhaDeLeitura.chamadas).toEqual([]);

    const gravacao = await rodar(LOJA, fakeShopee([pagina(false, [])]), { erroNaGravacao: "boom" });

    expect(gravacao.outcome).toMatchObject({ status: "failed", retryable: true });
    expect(gravacao.enfileirados).toEqual([]);
  });
});
