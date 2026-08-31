import { createLogger } from "@sb/observability";
import { describe, expect, it, vi } from "vitest";

import type { Caller } from "./auth.js";
import type { EnqueueRequest, Enqueuer } from "./enqueue.js";
import type { RelistDeps } from "./relist.js";
import { requestListingRelist, requestListingRelistExecution } from "./relist.js";

const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ITEM_ID = "MLB910000001";
const NOW = new Date("2026-08-31T12:00:30.000Z");

const ADMIN: Caller = { userId: "u-admin", organizationId: ORGANIZATION_ID, role: "ADMIN" };
const GESTOR: Caller = { userId: "u-gestor", organizationId: ORGANIZATION_ID, role: "GESTOR" };

const REQUEST = { mlAccountId: ML_ACCOUNT_ID, itemId: ITEM_ID };

const RELIST_ID = "cccccccc-0000-4000-8000-000000000001";

interface FakeDbOptions {
  accountOrganizationId?: string | null;
  hasAccountPermission?: boolean;
  listingExists?: boolean;
  operationStatus?: string;
  operationOrganizationId?: string;
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

              if (table === "listing_relists") {
                return Promise.resolve({
                  data: {
                    id: RELIST_ID,
                    organization_id: options.operationOrganizationId ?? ORGANIZATION_ID,
                    ml_account_id: ML_ACCOUNT_ID,
                    status: options.operationStatus ?? "REQUESTED",
                    parent_item_id: ITEM_ID,
                    ml_accounts: { slug: "loja-1" },
                  },
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

describe("requestListingRelistExecution (D-162)", () => {
  it("REQUESTED confirmada enfileira relist.execute na fila da conta", async () => {
    const { enqueuer, requests } = fakeEnqueuer();

    const outcome = await requestListingRelistExecution(deps(fakeDb(), enqueuer), ADMIN, RELIST_ID);

    expect(outcome).toEqual({ status: "queued", deduplicated: false });
    expect(requests[0]).toMatchObject({
      jobType: "relist.execute",
      queue: "ml-sync-loja-1",
      payload: { relistId: RELIST_ID },
    });
    expect(requests[0]?.dedupeKey).toBe(`relist-execute:${RELIST_ID}:2026-08-31T12:00`);
  });

  it("operação fora de REQUESTED é invalid — inclusive PREFLIGHT_FAILED, com a orientação de refazer o pedido", async () => {
    const { enqueuer, requests } = fakeEnqueuer();

    const reprovada = await requestListingRelistExecution(
      deps(fakeDb({ operationStatus: "PREFLIGHT_FAILED" }), enqueuer),
      ADMIN,
      RELIST_ID,
    );
    expect(reprovada).toMatchObject({ status: "invalid" });
    expect((reprovada as { reason: string }).reason).toContain("preflight");

    const emCurso = await requestListingRelistExecution(
      deps(fakeDb({ operationStatus: "RELISTING" }), enqueuer),
      ADMIN,
      RELIST_ID,
    );
    expect(emCurso).toMatchObject({ status: "invalid" });
    expect(requests).toHaveLength(0);
  });

  it("operação de outra organização é not_found; GESTOR sem permissão na conta idem (lição D-117)", async () => {
    const { enqueuer, requests } = fakeEnqueuer();

    const outraOrg = await requestListingRelistExecution(
      deps(fakeDb({ operationOrganizationId: "22222222-0000-4000-8000-000000000002" }), enqueuer),
      ADMIN,
      RELIST_ID,
    );
    expect(outraOrg).toEqual({ status: "not_found" });

    const semPermissao = await requestListingRelistExecution(
      deps(fakeDb({ hasAccountPermission: false }), enqueuer),
      GESTOR,
      RELIST_ID,
    );
    expect(semPermissao).toEqual({ status: "not_found" });
    expect(requests).toHaveLength(0);
  });
});
