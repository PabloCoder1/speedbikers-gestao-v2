import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { createShopeeClient } from "@sb/shopee";
import { describe, expect, it } from "vitest";

import type { ShopeeAdsSyncDeps } from "./shopee-ads-sync.js";
import { createShopeeAdsSyncHandler, hojeEmSaoPaulo, pedacos } from "./shopee-ads-sync.js";

const KEY = randomBytes(32);
// 14/10/2026 às 02:00 UTC = 13/10 às 23:00 em São Paulo.
const NOW = new Date("2026-10-14T02:00:00.000Z");
const LOJA_ID = "aaaaaaaa-0000-4000-8000-0000000000aa";
const ORG = "11111111-0000-4000-8000-000000000001";

const ENVELOPE = {
  jobType: "shopee.ads.sync",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b97",
  organizationId: ORG,
  dedupeKey: "shopee-ads:x",
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
  ads_read_until: string | null;
  ads_synced_at: string | null;
}

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
      if (nome !== "shopee_upsert_ads_days") throw new Error(`rpc inesperada: ${nome}`);

      if (opcoes.erroNaGravacao !== undefined) {
        return Promise.resolve({ data: null, error: { message: opcoes.erroNaGravacao } });
      }

      chamadas.push(args);

      return Promise.resolve({ data: (args.p_dias as unknown[]).length, error: null });
    },
    from: (table: string) => ({
      select: () => leitura({ data: table === "shopee_shops" ? loja : credencial, error: null }),
    }),
  } as unknown as ShopeeAdsSyncDeps["db"];

  return { db, chamadas };
}

function fakeShopee(opcoes: { dias?: unknown[]; erro?: string } = {}) {
  const pedidos: URLSearchParams[] = [];
  const fetchImpl = (url: URL) => {
    pedidos.push(url.searchParams);

    if (opcoes.erro !== undefined) {
      return Promise.resolve(new Response(JSON.stringify({ error: opcoes.erro, message: "x" }), { status: 200 }));
    }

    return Promise.resolve(new Response(JSON.stringify({ request_id: "r", response: opcoes.dias ?? [] }), { status: 200 }));
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

const LOJA: Loja = {
  id: LOJA_ID,
  organization_id: ORG,
  environment: "sandbox",
  shop_id: 54804,
  status: "CONNECTED",
  orders_synced_until: null,
  ads_read_until: null,
  ads_synced_at: null,
};

function rodar(loja: Loja, shopee: ReturnType<typeof fakeShopee>, opcoes: { erroNaGravacao?: string } = {}) {
  const { db, chamadas } = fakeDb(loja, opcoes);
  const handler = createShopeeAdsSyncHandler({
    db,
    client: shopee.client,
    encryptionKey: KEY,
    now: () => NOW,
    enqueuer: { enqueue: () => Promise.resolve({ deduplicated: false }) } as unknown as ShopeeAdsSyncDeps["enqueuer"],
  });

  return handler(ENVELOPE, {
    logger: createLogger({}, { sink: () => undefined }),
    payload: { shopeeShopId: LOJA_ID },
  }).then((outcome) => ({ outcome, chamadas }));
}

describe("shopee.ads.sync (D-449)", () => {
  it("o dia de hoje é o de São Paulo; os pedaços têm até 30 dias e nunca um dia sozinho", () => {
    expect(hojeEmSaoPaulo(NOW)).toBe("2026-10-13");
    expect(pedacos("2026-07-16", "2026-10-13")).toEqual([
      { startDate: "2026-07-16", endDate: "2026-08-14" },
      { startDate: "2026-08-15", endDate: "2026-09-13" },
      { startDate: "2026-09-14", endDate: "2026-10-13" },
    ]);
    expect(pedacos("2026-09-13", "2026-10-13")).toEqual([
      { startDate: "2026-09-13", endDate: "2026-10-12" },
      // O dia que sobrou começa um dia antes.
      { startDate: "2026-10-12", endDate: "2026-10-13" },
    ]);
  });

  it("primeira leitura: 90 dias em três pedidos, grava os dias e a cobertura", async () => {
    const shopee = fakeShopee({ dias: [{ date: "13-10-2026", impression: 100, clicks: 9, broad_order: 2, direct_gmv: 50, broad_gmv: 80, expense: 12.5 }] });
    const { outcome, chamadas } = await rodar(LOJA, shopee);

    expect(outcome.status).toBe("done");
    expect(shopee.pedidos.map((p) => [p.get("start_date"), p.get("end_date")])).toEqual([
      ["16-07-2026", "14-08-2026"],
      ["15-08-2026", "13-09-2026"],
      ["14-09-2026", "13-10-2026"],
    ]);
    expect(chamadas[0]).toMatchObject({ p_read_from: "2026-07-16", p_read_until: "2026-10-13" });
    expect((chamadas[0]?.p_dias as unknown[])[0]).toEqual({
      metric_date: "2026-10-13",
      impressions: 100,
      clicks: 9,
      direct_orders: null,
      broad_orders: 2,
      direct_items: null,
      broad_items: null,
      direct_gmv: 50,
      broad_gmv: 80,
      expense: 12.5,
    });
  });

  it("com leitura anterior relê as duas últimas semanas; lida há menos de 3 horas, não chama", async () => {
    const releitura = fakeShopee();
    const { chamadas } = await rodar({ ...LOJA, ads_read_until: "2026-10-13", ads_synced_at: "2026-10-13T20:00:00.000Z" }, releitura);

    expect(releitura.pedidos.map((p) => [p.get("start_date"), p.get("end_date")])).toEqual([["30-09-2026", "13-10-2026"]]);
    expect(chamadas[0]).toMatchObject({ p_read_from: "2026-09-30", p_read_until: "2026-10-13", p_dias: [] });

    const recente = fakeShopee();
    const pulada = await rodar({ ...LOJA, ads_read_until: "2026-10-13", ads_synced_at: "2026-10-14T01:00:00.000Z" }, recente);

    expect(pulada.outcome).toEqual({ status: "done", processed: 0 });
    expect(recente.pedidos).toEqual([]);
  });

  it("sem dado de Ads é período vazio; limite de requisições é passageiro; falha ao gravar repete", async () => {
    const vazio = await rodar(LOJA, fakeShopee({ erro: "error_not_found" }));

    expect(vazio.outcome.status).toBe("done");
    expect(vazio.chamadas[0]).toMatchObject({ p_dias: [] });

    const limite = await rodar(LOJA, fakeShopee({ erro: "ads.rate_limit.exceed_shop_api" }));

    expect(limite.outcome).toMatchObject({ status: "failed", retryable: true });

    const gravacao = await rodar(LOJA, fakeShopee(), { erroNaGravacao: "boom" });

    expect(gravacao.outcome).toMatchObject({ status: "failed", retryable: true });
  });
});
