import { createLogger } from "@sb/observability";
import { describe, expect, it, vi } from "vitest";

import type { Caller } from "./auth.js";
import type { EnqueueRequest, Enqueuer } from "./enqueue.js";
import type { RelistDeps } from "./relist.js";
import { requestListingRelist } from "./relist.js";

const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ITEM_ID = "MLB910000001";
const NOW = new Date("2026-08-31T12:00:30.000Z");

const ADMIN: Caller = { userId: "u-admin", organizationId: ORGANIZATION_ID, role: "ADMIN" };
const GESTOR: Caller = { userId: "u-gestor", organizationId: ORGANIZATION_ID, role: "GESTOR" };

const REQUEST = { mlAccountId: ML_ACCOUNT_ID, itemId: ITEM_ID };

interface FakeDbOptions {
  accountOrganizationId?: string | null;
  hasAccountPermission?: boolean;
  listingExists?: boolean;
}

function fakeDb(options: FakeDbOptions = {}): RelistDeps["db"] {
  const accountOrganizationId =
    options.accountOrganizationId === undefined ? ORGANIZATION_ID : options.accountOrganizationId;

  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => {
          const terminal = {
            maybeSingle: () => {
              if (table === "ml_accounts") {
                return Promise.resolve({
                  data:
                    accountOrganizationId === null
                      ? null
                      : { id: ML_ACCOUNT_ID, organization_id: accountOrganizationId, slug: "loja-1" },
                  error: null,
                });
              }

              if (table === "user_account_permissions") {
                return Promise.resolve({
                  data: options.hasAccountPermission === true ? { user_id: "u-gestor" } : null,
                  error: null,
                });
              }

              if (table === "listings") {
                return Promise.resolve({
                  data: options.listingExists === false ? null : { item_id: ITEM_ID },
                  error: null,
                });
              }

              return Promise.resolve({ data: null, error: null });
            },
            eq: () => terminal,
          };

          return terminal;
        },
      }),
    }),
  } as unknown as RelistDeps["db"];
}

function fakeEnqueuer(): { enqueuer: Enqueuer; requests: EnqueueRequest[] } {
  const requests: EnqueueRequest[] = [];

  const enqueuer: Enqueuer = {
    enqueue: vi.fn((request: EnqueueRequest) => {
      requests.push(request);

      return Promise.resolve({ taskName: "t", envelope: {} as never, deduplicated: false });
    }),
  };

  return { enqueuer, requests };
}

function deps(db: RelistDeps["db"], enqueuer: Enqueuer): RelistDeps {
  return { db, enqueuer, logger: createLogger({}, { sink: () => undefined }), now: () => NOW };
}

describe("requestListingRelist (D-161)", () => {
  it("ADMIN da organização enfileira relist.prepare na fila da CONTA, com o ator no payload", async () => {
    const { enqueuer, requests } = fakeEnqueuer();

    const outcome = await requestListingRelist(deps(fakeDb(), enqueuer), ADMIN, REQUEST);

    expect(outcome).toEqual({ status: "queued", deduplicated: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      jobType: "relist.prepare",
      queue: "ml-sync-loja-1",
      payload: { mlAccountId: ML_ACCOUNT_ID, itemId: ITEM_ID, requestedBy: "u-admin" },
    });
    // Janela de minuto no nome (classe D-051): pedido legítimo horas depois
    // não pode colidir com o nome retido pelo Cloud Tasks.
    expect(requests[0]?.dedupeKey).toBe(`relist-prepare:${ITEM_ID}:2026-08-31T12:00`);
  });

  it("conta de OUTRA organização é not_found — nunca 'sem permissão'", async () => {
    const { enqueuer, requests } = fakeEnqueuer();

    const outcome = await requestListingRelist(
      deps(fakeDb({ accountOrganizationId: "22222222-0000-4000-8000-000000000002" }), enqueuer),
      ADMIN,
      REQUEST,
    );

    expect(outcome).toEqual({ status: "not_found" });
    expect(requests).toHaveLength(0);
  });

  it("GESTOR sem permissão na CONTA é not_found (lição D-117); com permissão, enfileira", async () => {
    const { enqueuer: negado } = fakeEnqueuer();
    const semPermissao = await requestListingRelist(
      deps(fakeDb({ hasAccountPermission: false }), negado),
      GESTOR,
      REQUEST,
    );
    expect(semPermissao).toEqual({ status: "not_found" });

    const { enqueuer: permitido, requests } = fakeEnqueuer();
    const comPermissao = await requestListingRelist(
      deps(fakeDb({ hasAccountPermission: true }), permitido),
      GESTOR,
      REQUEST,
    );
    expect(comPermissao).toMatchObject({ status: "queued" });
    expect(requests[0]?.payload).toMatchObject({ requestedBy: "u-gestor" });
  });

  it("anúncio que a V3 não conhece é not_found — falha cedo, não no worker", async () => {
    const { enqueuer, requests } = fakeEnqueuer();

    const outcome = await requestListingRelist(deps(fakeDb({ listingExists: false }), enqueuer), ADMIN, REQUEST);

    expect(outcome).toEqual({ status: "not_found" });
    expect(requests).toHaveLength(0);
  });
});
