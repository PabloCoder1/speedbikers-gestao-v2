import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  createSyncSupportClaimsReconcileHandler,
  resolveNotifyEpoch,
} from "./sync-support-claims-reconcile.js";

describe("resolveNotifyEpoch (D-110)", () => {
  it("conta antiga usa a época global — o estoque pré-deploy fica mudo", () => {
    expect(resolveNotifyEpoch("2026-08-21T10:00:00.000Z")).toBe("2026-08-27T21:00:00.000Z");
  });

  it("conta conectada DEPOIS do deploy usa a própria conexão como piso", () => {
    // O cenário da conta nova conectada meses depois: sem o piso, a primeira
    // varredura despejaria os 7 dias de backlog pré-conexão como notificação
    // — a segunda falha bloqueante do desenho original.
    expect(resolveNotifyEpoch("2026-12-01T15:30:00.000Z")).toBe("2026-12-01T15:30:00.000Z");
  });

  it("sem connected_at, a época global vale sozinha", () => {
    expect(resolveNotifyEpoch(null)).toBe("2026-08-27T21:00:00.000Z");
  });

  it("compara instantes, não strings — offset não engana o piso", () => {
    // 19:00-03:00 = 22:00Z, uma hora DEPOIS da época global de 21:00Z.
    expect(resolveNotifyEpoch("2026-08-27T19:00:00.000-03:00")).toBe("2026-08-27T22:00:00.000Z");
  });
});

describe("createSyncSupportClaimsReconcileHandler (D-796)", () => {
  const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
  const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
  const ENCRYPTION_KEY = randomBytes(32);
  const NOW = new Date("2026-09-01T15:00:00.000Z");
  const ENVELOPE = {
    jobType: "sync.support.claims.reconcile",
    jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b99",
    organizationId: ORGANIZATION_ID,
    dedupeKey: "claims:1",
    attempt: 1,
    enqueuedAt: NOW.toISOString(),
  };

  function setup(storedCheckpoint: string | null, clientBehavior?: () => Promise<never>) {
    const inserted: { table: string; row: unknown }[] = [];
    const requests: RequestOptions<unknown>[] = [];
    const chain = <T>(result: T) => {
      const self = {
        eq: () => self,
        not: () => self,
        order: () => self,
        limit: () => self,
        select: () => self,
        maybeSingle: () => Promise.resolve(result),
        then: <R>(resolve: (value: T) => R) => Promise.resolve(result).then(resolve),
      };

      return self;
    };

    const db = {
      from: (table: string) => ({
        select: () => {
          if (table === "ml_accounts") {
            return chain({
              data: {
                id: ML_ACCOUNT_ID,
                organization_id: ORGANIZATION_ID,
                seller_id: 123456,
                status: "CONNECTED",
                connected_at: "2026-08-20T00:00:00.000Z",
              },
              error: null,
            });
          }

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

          return chain({
            data: storedCheckpoint === null ? null : { latest_record_at: storedCheckpoint },
            error: null,
          });
        },
        insert: (row: unknown) => {
          inserted.push({ table, row });

          return chain({ data: { id: "run-1" }, error: null });
        },
      }),
    };

    const client: MercadoLivreClient = {
      request: (options) => {
        requests.push(options);

        if (clientBehavior !== undefined) {
          return clientBehavior();
        }

        return Promise.resolve({ paging: { total: 0, offset: 0, limit: 30 }, data: [] } as never);
      },
    };

    const handler = createSyncSupportClaimsReconcileHandler({
      db: db as never,
      mercadoLivre: client,
      oauth: { clientId: "APP", clientSecret: "secret", redirectUri: "" },
      encryptionKey: ENCRYPTION_KEY,
      now: () => NOW,
    });

    return {
      inserted,
      requests,
      run: () =>
        handler(ENVELOPE, {
          logger: createLogger({}, { sink: () => undefined }),
          payload: { mlAccountId: ML_ACCOUNT_ID },
        }),
    };
  }

  it("checkpoint no futuro limita updatedAfter a now - 10min e checkpoint inválido cai no fallback de 7 dias", async () => {
    const futuro = setup("2026-09-01T18:00:00.000Z");

    await expect(futuro.run()).resolves.toEqual({ status: "done", processed: 0 });
    expect(new URL(`https://api.mercadolibre.com${futuro.requests[0]?.path ?? ""}`).searchParams.get("range")).toBe(
      "last_updated:after:2026-09-01T14:50:00.000+00:00",
    );

    const invalido = setup("nao-e-data");

    await expect(invalido.run()).resolves.toEqual({ status: "done", processed: 0 });
    expect(new URL(`https://api.mercadolibre.com${invalido.requests[0]?.path ?? ""}`).searchParams.get("range")).toBe(
      "last_updated:after:2026-08-25T15:00:00.000+00:00",
    );
  });

  it("ZodError na busca de claims falha como not_retryable", async () => {
    const ctx = setup(null, () =>
      Promise.reject(new ZodError([{ code: "invalid_type", expected: "array", path: ["data"], message: "x" }])),
    );

    await expect(ctx.run()).resolves.toMatchObject({ status: "failed", retryable: false });
    expect(ctx.inserted.find((e) => e.table === "sync_errors")?.row).toMatchObject({ error_class: "not_retryable" });
  });
});
