import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import { fetchSupportClaims } from "./ml-support-claims-fetch.js";

const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SELLER_ID = 1295357671;
const UPDATED_AFTER = "2026-08-27T00:00:00.000+00:00";

const logger = createLogger({}, { sink: () => undefined });

function claim(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    resource: "order",
    resource_id: 2000005051445424,
    status: "opened",
    type: "mediations",
    stage: "claim",
    players: [{ role: "respondent", type: "seller", user_id: SELLER_ID, available_actions: [] }],
    date_created: "2026-08-27T10:00:00.000-03:00",
    last_updated: "2026-08-27T11:00:00.000-03:00",
    related_entities: [],
    ...overrides,
  };
}

/** Fake mínimo: só as escritas que `ingestSupportClaim` faz. */
function fakeDb() {
  const upserted: Record<string, unknown>[] = [];
  const chain = {
    eq: () => chain,
    not: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    select: () => ({ single: () => Promise.resolve({ data: { id: "case-1" }, error: null }) }),
    then<T>(onFulfilled?: ((value: { data: null; error: null }) => T) | null) {
      const result = { data: null, error: null } as const;
      return onFulfilled == null ? Promise.resolve(result) : Promise.resolve(onFulfilled(result));
    },
  };

  return {
    upserted,
    db: {
      rpc: () => Promise.resolve({ data: true, error: null }),
      from: () => ({
        select: () => chain,
        upsert: (input: Record<string, unknown> | Record<string, unknown>[]) => {
          for (const row of Array.isArray(input) ? input : [input]) {
            upserted.push(row);
          }
          return Promise.resolve({ data: null, error: null });
        },
        update: () => chain,
        insert: () => Promise.resolve({ data: null, error: null }),
        delete: () => chain,
      }),
    } as never,
  };
}

/** Devolve páginas de busca por papel; transcript e detalhe vazios. */
function fakeMercadoLivre(pagesByRole: Record<string, unknown[][]>) {
  const requests: RequestOptions<unknown>[] = [];

  const client = {
    request: (options: RequestOptions<unknown>) => {
      requests.push(options);

      if (options.path.includes("/messages")) {
        return Promise.resolve([]);
      }

      if (options.path.includes("/detail")) {
        return Promise.resolve({ due_date: null });
      }

      const role = new URL(`https://x${options.path}`).searchParams.get("players.role") ?? "";
      const offset = Number(new URL(`https://x${options.path}`).searchParams.get("offset") ?? "0");
      const page = pagesByRole[role]?.[offset / 100] ?? [];

      return Promise.resolve({ data: page, paging: { total: page.length } });
    },
  } as unknown as MercadoLivreClient;

  return { client, requests };
}

function run(pagesByRole: Record<string, unknown[][]>) {
  const fake = fakeDb();
  const { client, requests } = fakeMercadoLivre(pagesByRole);

  return fetchSupportClaims({
    db: fake.db,
    organizationId: ORGANIZATION_ID,
    mlAccountId: ML_ACCOUNT_ID,
    sellerId: SELLER_ID,
    mercadoLivre: client,
    accessToken: "token",
    updatedAfter: UPDATED_AFTER,
    logger,
  }).then((result) => ({ result, requests }));
}

function searchRequests(requests: RequestOptions<unknown>[]) {
  return requests.filter((request) => request.path.includes("/claims/search"));
}

describe("fetchSupportClaims", () => {
  it("varre os DOIS papéis — o vendedor reclama em cancel_sale", () => {
    // `players.role` é obrigatório junto de `players.user_id` (a API dá 400
    // sem ele), então varrer só `respondent` perderia uma categoria inteira.
    return run({ respondent: [[]], complainant: [[]] }).then(({ requests }) => {
      const roles = searchRequests(requests).map((request) =>
        new URL(`https://x${request.path}`).searchParams.get("players.role"),
      );

      expect(roles).toContain("respondent");
      expect(roles).toContain("complainant");
    });
  });

  it("usa os filtros que a doc EXIGE, nunca `status` sozinho", () => {
    return run({ respondent: [[]], complainant: [[]] }).then(({ requests }) => {
      const params = new URL(`https://x${searchRequests(requests)[0]?.path ?? ""}`).searchParams;

      expect(params.get("players.user_id")).toBe(String(SELLER_ID));
      expect(params.get("players.role")).toBe("respondent");
      expect(params.get("range")).toBe(`last_updated:after:${UPDATED_AFTER}`);
      expect(params.get("status")).toBeNull();
    });
  });

  it("o mesmo claim nos dois papéis é ingerido UMA vez", () => {
    return run({ respondent: [[claim(1)]], complainant: [[claim(1)]] }).then(({ result }) => {
      expect(result.itemsProcessed).toBe(1);
    });
  });

  it("devolve o maior `last_updated` como checkpoint", () => {
    return run({
      respondent: [[claim(1), claim(2, { last_updated: "2026-08-27T15:00:00.000-03:00" })]],
      complainant: [[]],
    }).then(({ result }) => {
      expect(result.latestRecordAt).toBe("2026-08-27T15:00:00.000-03:00");
      expect(result.itemsProcessed).toBe(2);
    });
  });

  it("aceita o array em `data` E em `results` — o material oficial usa os dois", () => {
    const fake = fakeDb();
    const client = {
      request: (options: RequestOptions<unknown>) => {
        if (options.path.includes("/messages")) {
          return Promise.resolve([]);
        }
        if (options.path.includes("/detail")) {
          return Promise.resolve({ due_date: null });
        }
        return Promise.resolve({ results: [claim(7)] });
      },
    } as unknown as MercadoLivreClient;

    return fetchSupportClaims({
      db: fake.db,
      organizationId: ORGANIZATION_ID,
      mlAccountId: ML_ACCOUNT_ID,
      sellerId: SELLER_ID,
      mercadoLivre: client,
      accessToken: "token",
      updatedAfter: UPDATED_AFTER,
      logger,
    }).then((result) => {
      // Uma vez só: a dedupe por id absorve o segundo papel.
      expect(result.itemsProcessed).toBe(1);
    });
  });

  it("página incompleta encerra a paginação daquele papel", () => {
    return run({ respondent: [[claim(1)]], complainant: [[]] }).then(({ requests }) => {
      const respondentPages = searchRequests(requests).filter(
        (request) => new URL(`https://x${request.path}`).searchParams.get("players.role") === "respondent",
      );

      expect(respondentPages).toHaveLength(1);
    });
  });

  it("transcript e detalhe são buscados por claim ingerido", () => {
    return run({ respondent: [[claim(1)]], complainant: [[]] }).then(({ requests }) => {
      expect(requests.some((request) => request.path.endsWith("/claims/1/messages"))).toBe(true);
      expect(requests.some((request) => request.path.endsWith("/claims/1/detail"))).toBe(true);
    });
  });
});
