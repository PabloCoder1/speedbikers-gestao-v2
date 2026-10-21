import { randomBytes } from "node:crypto";

import { encryptToken, MercadoLivreApiError } from "@sb/mercado-livre";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { fetchListings } from "./ml-listings-fetch.js";
import type { SyncListingItemDeps } from "./sync-listing-item.js";

const fetchListingsMock = vi.hoisted(() => vi.fn<typeof fetchListings>());

vi.mock("./ml-listings-fetch.js", () => ({ fetchListings: fetchListingsMock }));

const { createSyncListingItemHandler } = await import("./sync-listing-item.js");

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const SELLER_ID = 118570204;
const NOW = new Date("2026-10-21T18:00:00.000Z");
const ENCRYPTION_KEY = randomBytes(32);

const ENVELOPE = {
  jobType: "sync.listing.item",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b41",
  organizationId: ORGANIZATION_ID,
  dedupeKey: "ml-webhook:/items/MLB5:2026-10-21T18:00",
  attempt: 1,
  enqueuedAt: NOW.toISOString(),
};

const CONTA = { id: ML_ACCOUNT_ID, organization_id: ORGANIZATION_ID, status: "CONNECTED", seller_id: SELLER_ID };

function chain<T>(result: T) {
  const self = { eq: () => self, maybeSingle: () => Promise.resolve(result) };

  return self;
}

function fakeDb(conta: Record<string, unknown> | null = CONTA): SyncListingItemDeps["db"] {
  return {
    from: (table: string) => ({
      select: () => {
        if (table === "ml_accounts") return chain({ data: conta, error: null });

        if (table === "ml_credentials") {
          return chain({
            data: {
              access_token_ciphertext: encryptToken("APP_USR-valido", ENCRYPTION_KEY),
              refresh_token_ciphertext: encryptToken("TG-valido", ENCRYPTION_KEY),
              access_token_expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
            },
            error: null,
          });
        }

        throw new Error(`select inesperado em ${table}`);
      },
    }),
  } as unknown as SyncListingItemDeps["db"];
}

function run(conta: Record<string, unknown> | null = CONTA, payload: unknown = { mlAccountId: ML_ACCOUNT_ID, itemId: "MLB5" }) {
  const lines: string[] = [];
  const client: MercadoLivreClient = { request: () => Promise.reject(new Error("não usado")) };
  const handler = createSyncListingItemHandler({
    db: fakeDb(conta),
    mercadoLivre: client,
    oauth: { clientId: "APP_ID", clientSecret: "segredo", redirectUri: "" },
    encryptionKey: ENCRYPTION_KEY,
    now: () => NOW,
  });

  return { lines, outcome: handler(ENVELOPE, { payload, logger: createLogger({}, { sink: (line) => lines.push(line) }) }) };
}

const RESULTADO = { itemsDiscovered: 1, itemsProcessed: 1, itemsFailed: 0, itemsWithoutLink: 0, itemsMarkedDeleted: 0, itemsOutsideScan: 0 };

beforeEach(() => {
  fetchListingsMock.mockReset();
  fetchListingsMock.mockResolvedValue(RESULTADO);
});

describe("sync.listing.item (D-631)", () => {
  it("lê só o anúncio da notificação, com a leitura da varredura", async () => {
    const { outcome, lines } = run();

    expect(await outcome).toEqual({ status: "done", processed: 1 });
    expect(fetchListingsMock.mock.calls[0]?.[0]).toMatchObject({
      organizationId: ORGANIZATION_ID,
      mlAccountId: ML_ACCOUNT_ID,
      sellerId: SELLER_ID,
      itemIds: ["MLB5"],
      accessToken: "APP_USR-valido",
    });
    expect(lines.join()).toContain("sync_listing_item_done");
    expect(lines.join()).not.toContain("APP_USR-valido");
  });

  it("o anúncio excluído conta como processado", async () => {
    fetchListingsMock.mockResolvedValue({ ...RESULTADO, itemsProcessed: 0, itemsMarkedDeleted: 1 });

    expect(await run().outcome).toEqual({ status: "done", processed: 1 });
  });

  it("payload sem item válido, conta de outra organização e conta desconectada não leem o Mercado Livre", async () => {
    expect(await run(CONTA, { mlAccountId: ML_ACCOUNT_ID, itemId: "123" }).outcome).toMatchObject({ status: "failed", retryable: false });
    expect(await run({ ...CONTA, organization_id: "22222222-0000-4000-8000-000000000002" }).outcome).toMatchObject({ status: "failed", retryable: false });
    expect(await run({ ...CONTA, status: "REVOKED" }).outcome).toEqual({ status: "done", processed: 0 });
    expect(await run(null).outcome).toEqual({ status: "done", processed: 0 });
    expect(fetchListingsMock).not.toHaveBeenCalled();
  });

  it("erro definitivo do Mercado Livre não repete; o passageiro, sim", async () => {
    fetchListingsMock.mockRejectedValueOnce(new MercadoLivreApiError("403", { status: 403, errorClass: "not_retryable", url: "/items" }));
    expect(await run().outcome).toMatchObject({ status: "failed", retryable: false });

    fetchListingsMock.mockRejectedValueOnce(new Error("rede"));
    expect(await run().outcome).toMatchObject({ status: "failed", retryable: true });
  });
});
