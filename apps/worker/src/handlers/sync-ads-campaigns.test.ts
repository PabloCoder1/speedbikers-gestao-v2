import { randomBytes } from "node:crypto";

import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { MercadoLivreApiError, encryptToken } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { SyncAdsCampaignsDeps } from "./sync-ads-campaigns.js";
import { createSyncAdsCampaignsHandler } from "./sync-ads-campaigns.js";

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ENCRYPTION_KEY = randomBytes(32);
const NOW = new Date("2026-09-16T14:00:00.000Z");
const OAUTH = { clientId: "APP", clientSecret: "s", redirectUri: "" };

const ENVELOPE = {
  jobType: "sync.ads.campaigns",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b22",
  organizationId: ORGANIZATION_ID,
  dedupeKey: "ads:loja-1:2026-09-16",
  attempt: 1,
  enqueuedAt: NOW.toISOString(),
};

interface Gravacao {
  tabela: string;
  operacao: "upsert" | "insert";
  valores: unknown;
  opcoes?: unknown;
}

function fakeDb(conta: { status: string } | null = { status: "CONNECTED" }): {
  db: SyncAdsCampaignsDeps["db"];
  gravacoes: Gravacao[];
} {
  const gravacoes: Gravacao[] = [];
  const linhas: Record<string, unknown> = {
    ml_accounts: conta === null ? null : { id: ML_ACCOUNT_ID, organization_id: ORGANIZATION_ID, status: conta.status },
    ml_credentials: {
      access_token_ciphertext: encryptToken("APP_USR-valido", ENCRYPTION_KEY),
      refresh_token_ciphertext: encryptToken("TG-valido", ENCRYPTION_KEY),
      access_token_expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
    },
  };

  const db = {
    from: (tabela: string) => {
      const leitura = {
        eq: () => leitura,
        maybeSingle: () => Promise.resolve({ data: linhas[tabela] ?? null, error: null }),
      };
      const ok = { error: null, data: null };
      const insercao = {
        select: () => ({
          single: () => Promise.resolve({ data: { id: "run-1" }, error: null }),
          maybeSingle: () => Promise.resolve({ data: { id: "run-1" }, error: null }),
        }),
        then: <R>(resolve: (value: typeof ok) => R) => Promise.resolve(ok).then(resolve),
      };

      return {
        select: () => leitura,
        upsert: (valores: unknown, opcoes: unknown) => {
          gravacoes.push({ tabela, operacao: "upsert", valores, opcoes });

          return Promise.resolve(ok);
        },
        insert: (valores: unknown) => {
          gravacoes.push({ tabela, operacao: "insert", valores });

          return insercao;
        },
      };
    },
  };

  return { db: db as unknown as SyncAdsCampaignsDeps["db"], gravacoes };
}

type Rota = (options: RequestOptions<unknown>) => unknown;

function fakeMl(rota: Rota): { client: MercadoLivreClient; chamadas: RequestOptions<unknown>[] } {
  const chamadas: RequestOptions<unknown>[] = [];

  return {
    chamadas,
    client: {
      request: <T>(options: RequestOptions<T>): Promise<T> => {
        chamadas.push(options);

        try {
          return Promise.resolve(options.schema.parse(rota(options as RequestOptions<unknown>)));
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error("falha"));
        }
      },
    },
  };
}

const DIA = {
  date: "2026-09-15",
  clicks: 10,
  prints: 800,
  cost: 12.5,
  direct_amount: 120,
  indirect_amount: 30,
  total_amount: 150,
  direct_units_quantity: 1,
  indirect_units_quantity: 1,
  units_quantity: 2,
  organic_units_quantity: 4,
  organic_units_amount: 400,
};

const contexto = (): Parameters<ReturnType<typeof createSyncAdsCampaignsHandler>>[1] => ({
  logger: createLogger({ service: "worker-test" }),
  payload: { mlAccountId: ML_ACCOUNT_ID },
});

function handler(db: SyncAdsCampaignsDeps["db"], client: MercadoLivreClient) {
  return createSyncAdsCampaignsHandler({
    db,
    mercadoLivre: client,
    oauth: OAUTH,
    encryptionKey: ENCRYPTION_KEY,
    now: () => NOW,
    sleep: () => Promise.resolve(),
  });
}

describe("sync.ads.campaigns", () => {
  it("grava anunciante, campanhas e 90 dias de métricas por campanha", async () => {
    const { db, gravacoes } = fakeDb();
    const { client, chamadas } = fakeMl((o) => {
      if (o.path === "/advertising/advertisers") return { advertisers: [{ advertiser_id: 222, site_id: "MLB" }] };
      if (o.path.endsWith("/campaigns/search")) {
        return {
          paging: { total: 2, offset: 0, limit: 50 },
          results: [
            { id: 1, name: "Relação", status: "active", strategy: "PROFITABILITY", budget: 30, roas_target: 8 },
            { id: 2, name: "Pneus", status: "paused" },
          ],
        };
      }

      return [DIA];
    });

    const resultado = await handler(db, client)(ENVELOPE, contexto());

    expect(resultado).toEqual({ status: "done", processed: 2 });

    const anunciante = gravacoes.find((g) => g.tabela === "ads_advertisers");
    expect(anunciante?.valores).toMatchObject({ status: "habilitado", advertiser_id: 222, site_id: "MLB" });

    const campanhas = gravacoes.find((g) => g.tabela === "ads_campaigns");
    expect(campanhas?.valores).toHaveLength(2);
    expect(campanhas?.opcoes).toEqual({ onConflict: "ml_account_id,campaign_id" });

    const metricas = gravacoes.filter((g) => g.tabela === "daily_ads_campaign_metrics");
    expect(metricas).toHaveLength(2);
    expect((metricas[0]?.valores as { cost: number; units: number }[])[0]).toMatchObject({ cost: 12.5, units: 2, metric_date: "2026-09-15" });

    // A janela é o máximo da doc: 90 dias fechados, terminando hoje (SP).
    const detalhe = chamadas.find((c) => c.path === "/advertising/MLB/product_ads/campaigns/1");
    expect(detalhe?.searchParams).toMatchObject({ date_to: "2026-09-16", date_from: "2026-06-19", aggregation_type: "DAILY" });

    expect(gravacoes.some((g) => g.tabela === "sync_runs")).toBe(true);
  });

  it("conta sem Product Ads: grava 'nao_habilitado' e termina done, sem pedir campanhas", async () => {
    const { db, gravacoes } = fakeDb();
    const { client, chamadas } = fakeMl((o) => {
      if (o.path === "/advertising/advertisers") {
        throw new MercadoLivreApiError("404", { status: 404, errorClass: "not_retryable", url: o.path });
      }

      return {};
    });

    await expect(handler(db, client)(ENVELOPE, contexto())).resolves.toEqual({ status: "done", processed: 0 });
    expect(gravacoes.find((g) => g.tabela === "ads_advertisers")?.valores).toMatchObject({
      status: "nao_habilitado",
      advertiser_id: null,
    });
    expect(chamadas).toHaveLength(1);
  });

  it("campanha recusada (404) vira parcial e as outras seguem", async () => {
    const { db, gravacoes } = fakeDb();
    const { client } = fakeMl((o) => {
      if (o.path === "/advertising/advertisers") return { advertisers: [{ advertiser_id: 222, site_id: "MLB" }] };
      if (o.path.endsWith("/campaigns/search")) {
        return { paging: { total: 2, offset: 0, limit: 50 }, results: [{ id: 1, name: "A", status: "active" }, { id: 2, name: "B", status: "active" }] };
      }
      if (o.path.endsWith("/campaigns/1")) {
        throw new MercadoLivreApiError("404", { status: 404, errorClass: "not_retryable", url: o.path });
      }

      return [DIA];
    });

    await expect(handler(db, client)(ENVELOPE, contexto())).resolves.toEqual({ status: "done", processed: 1 });
    const run = gravacoes.find((g) => g.tabela === "sync_runs")?.valores as { status: string };
    expect(run.status).toBe("partial");
  });

  it("erro retryable devolve para a fila e registra a falha", async () => {
    const { db, gravacoes } = fakeDb();
    const { client } = fakeMl((o) => {
      throw new MercadoLivreApiError("503", { status: 503, errorClass: "retryable", url: o.path });
    });

    await expect(handler(db, client)(ENVELOPE, contexto())).resolves.toMatchObject({ status: "failed", retryable: true });
    expect(gravacoes.some((g) => g.tabela === "sync_runs")).toBe(true);
  });

  it("conta não conectada ou inexistente não chama o Mercado Livre", async () => {
    const { client, chamadas } = fakeMl(() => ({}));

    await expect(handler(fakeDb({ status: "ERROR" }).db, client)(ENVELOPE, contexto())).resolves.toEqual({ status: "done", processed: 0 });
    await expect(handler(fakeDb(null).db, client)(ENVELOPE, contexto())).resolves.toEqual({ status: "done", processed: 0 });
    expect(chamadas).toHaveLength(0);
  });

  it("payload sem conta falha sem retry", async () => {
    const { client } = fakeMl(() => ({}));

    await expect(
      handler(fakeDb().db, client)(ENVELOPE, { ...contexto(), payload: {} }),
    ).resolves.toMatchObject({ status: "failed", retryable: false });
  });
});
