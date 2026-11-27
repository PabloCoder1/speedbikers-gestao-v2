import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { RelistPrepareDeps } from "./relist-prepare.js";
import { createRelistPrepareHandler } from "./relist-prepare.js";

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "22222222-0000-4000-8000-000000000002";
const REQUESTED_BY = "bbbbbbbb-0000-4000-8000-000000000002";
const ITEM_ID = "MLB910000001";
const ENCRYPTION_KEY = randomBytes(32);
const NOW = new Date("2026-08-31T12:00:00.000Z");

const ENVELOPE = {
  jobType: "relist.prepare",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b33",
  organizationId: ORGANIZATION_ID,
  dedupeKey: `relist-prepare:${ITEM_ID}:2026-08-31T12:00`,
  attempt: 1,
  enqueuedAt: NOW.toISOString(),
};

const PAYLOAD = { mlAccountId: ML_ACCOUNT_ID, itemId: ITEM_ID, requestedBy: REQUESTED_BY };

function createMockMlClient(itemBody: Record<string, unknown>): {
  client: MercadoLivreClient;
  calls: string[];
} {
  const calls: string[] = [];
  const client = {
    request: <T>(request: RequestOptions<T>) => {
      calls.push(request.path);

      if (request.path === "/items/bulk") {
        return Promise.resolve(
          request.schema.parse([{ id: ITEM_ID, status_code: 200, body: itemBody }]),
        );
      }

      return Promise.resolve(request.schema.parse([{ code: 200, body: itemBody }]));
    },
  } as unknown as MercadoLivreClient;

  return { client, calls };
}

function createMockDb(options: {
  accountOrganizationId?: string;
  throwOnEventInsert?: boolean;
}): {
  db: RelistPrepareDeps["db"];
  relistChecks: number;
  relistInserts: Record<string, unknown>[];
} {
  let relistChecks = 0;
  const relistInserts: Record<string, unknown>[] = [];
  const credentials = {
    access_token_ciphertext: encryptToken("APP_USR-valido", ENCRYPTION_KEY),
    refresh_token_ciphertext: encryptToken("TG-valido", ENCRYPTION_KEY),
    access_token_expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
  };

  function chain(result: unknown): unknown {
    const self = {
      eq: () => self,
      not: () => self,
      limit: () => self,
      select: () => self,
      maybeSingle: () => Promise.resolve(result),
    };

    return self;
  }

  const db = {
    from: (table: string) => ({
      select: () => {
        if (table === "ml_accounts") {
          return chain({
            data: {
              id: ML_ACCOUNT_ID,
              organization_id: options.accountOrganizationId ?? ORGANIZATION_ID,
              status: "CONNECTED",
            },
            error: null,
          });
        }

        if (table === "ml_credentials") {
          return chain({ data: credentials, error: null });
        }

        if (table === "listing_relists") {
          relistChecks += 1;

          return chain({ data: null, error: null });
        }

        return chain({ data: null, error: null });
      },
      insert: (row: Record<string, unknown>) => {
        if (table === "listing_relists") {
          relistInserts.push(row);

          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id: "relist-1" }, error: null }),
            }),
          };
        }

        if (table === "listing_relist_events" && options.throwOnEventInsert === true) {
          return Promise.reject(new Error("fetch failed"));
        }

        return Promise.resolve({ error: null });
      },
    }),
  } as unknown as RelistPrepareDeps["db"];

  return { db, relistChecks, relistInserts };
}

describe("relist.prepare hardening (D-825)", () => {
  it("recusa conta de outra organização antes de consultar listing_relists ou o Mercado Livre", async () => {
    const { db, relistInserts } = createMockDb({ accountOrganizationId: OTHER_ORG_ID });
    const { client, calls } = createMockMlClient({
      id: ITEM_ID,
      tags: ["good_quality_picture"],
      catalog_listing: false,
      listing_type_id: "gold_special",
      available_quantity: 5,
      variations: [],
    });

    const handler = createRelistPrepareHandler({
      db,
      mercadoLivre: client,
      oauth: { clientId: "id", clientSecret: "secret", redirectUri: "https://example.test/cb" },
      encryptionKey: ENCRYPTION_KEY,
      now: () => NOW,
    });

    const outcome = await handler(ENVELOPE, {
      payload: PAYLOAD,
      logger: createLogger({}, { sink: () => undefined }),
    });

    expect(outcome).toEqual({
      status: "failed",
      retryable: false,
      reason: "conta do Mercado Livre pertence a outra organização",
    });
    expect(calls).toHaveLength(0);
    expect(relistInserts).toHaveLength(0);
  });

  it("sobrevive a erro de transporte em listing_relist_events.insert sem derrubar o job pós-insert", async () => {
    const { db, relistInserts } = createMockDb({ throwOnEventInsert: true });
    // Item reprovado no preflight (catalog_listing: true) exercita os DOIS inserts de evento (REQUESTED e PREFLIGHT_FAILED).
    const { client } = createMockMlClient({
      id: ITEM_ID,
      tags: ["good_quality_picture"],
      catalog_listing: true,
      listing_type_id: "gold_special",
      available_quantity: 5,
      variations: [],
    });

    const logs: string[] = [];
    const handler = createRelistPrepareHandler({
      db,
      mercadoLivre: client,
      oauth: { clientId: "id", clientSecret: "secret", redirectUri: "https://example.test/cb" },
      encryptionKey: ENCRYPTION_KEY,
      now: () => NOW,
    });

    const outcome = await handler(ENVELOPE, {
      payload: PAYLOAD,
      logger: createLogger({}, { sink: (line) => logs.push(line) }),
    });

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(relistInserts).toHaveLength(1);
    expect(logs.filter((line) => line.includes("relist_event_not_recorded"))).toHaveLength(2);
  });
});
