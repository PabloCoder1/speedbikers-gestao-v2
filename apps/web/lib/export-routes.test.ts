import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as exportarAnuncios } from "../app/(app)/anuncios/exportar/route";
import { GET as exportarAnunciosShopee } from "../app/(app)/anuncios/shopee/exportar/route";
import { GET as exportarCurvaAbc } from "../app/(app)/curva-abc/export/xlsx/route";
import { GET as exportarFull } from "../app/(app)/full/exportar/route";
import { GET as exportarPrecos } from "../app/(app)/precos/export/xlsx/route";
import { GET as exportarVendas } from "../app/(app)/vendas/exportar/route";
import { GET as exportarVendasShopee } from "../app/(app)/vendas/shopee/exportar/route";

const m = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("./supabase/server", () => ({ createClient: m.createClient }));

interface FakeRouteDb {
  membershipResult?: { data: unknown; error: { message: string } | null };
  tables?: Record<string, { data: unknown; error: { message: string } | null }>;
}

function makeDb(config: FakeRouteDb) {
  const rpcs: string[] = [];
  const tablesRead: string[] = [];

  const chain = (result: { data: unknown; error: { message: string } | null }) => {
    const self: Record<string, unknown> = {
      select: () => self,
      order: () => self,
      eq: () => self,
      then: (resolve: (v: unknown) => void) => {
        resolve(result);
      },
    };

    return self;
  };

  const membership = config.membershipResult ?? {
    data: [{ organization_id: "11111111-0000-4000-8000-000000000001", organization_name: "SB", role: "ADMIN" }],
    error: null,
  };

  const db = {
    rpc: (name: string) => {
      rpcs.push(name);
      if (name === "get_current_membership") return Promise.resolve(membership);

      return Promise.resolve({ data: [], error: null });
    },
    from: (table: string) => {
      tablesRead.push(table);
      const result = config.tables?.[table] ?? { data: [], error: null };

      return chain(result);
    },
  };

  return { db, rpcs, tablesRead };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("rotas de exportação: erro de contas não derruba filtro e erro de membership devolve 503 (D-774)", () => {
  it("/anuncios/exportar recusa 502 quando ml_accounts falha em vez de ignorar ?conta=", async () => {
    const { db, rpcs } = makeDb({
      tables: { ml_accounts: { data: null, error: { message: "timeout" } } },
    });
    m.createClient.mockResolvedValue(db);

    const response = await exportarAnuncios(new NextRequest("http://localhost/anuncios/exportar?conta=speed-bikers"));

    expect(response.status).toBe(502);
    expect(rpcs).not.toContain("get_listings_dashboard");
  });

  it("/curva-abc/export/xlsx recusa 502 quando ml_accounts (ML) ou marketplace_accounts (Todos) falha", async () => {
    const ml = makeDb({
      tables: { ml_accounts: { data: null, error: { message: "db indisponível" } } },
    });
    m.createClient.mockResolvedValue(ml.db);

    const respMl = await exportarCurvaAbc(new Request("http://localhost/curva-abc/export/xlsx?conta=speed-bikers"));

    expect(respMl.status).toBe(502);
    expect(ml.rpcs).not.toContain("get_sku_abc_analysis");

    const todos = makeDb({
      tables: { marketplace_accounts: { data: null, error: { message: "db indisponível" } } },
    });
    m.createClient.mockResolvedValue(todos.db);

    const respTodos = await exportarCurvaAbc(
      new Request("http://localhost/curva-abc/export/xlsx?marketplace=todos&contas=aaaaaaaa-0000-4000-8000-000000000001"),
    );

    expect(respTodos.status).toBe(502);
    expect(todos.tablesRead).not.toContain("ml_accounts");
    expect(todos.rpcs).not.toContain("get_sku_abc_analysis");
  });

  it("/precos/export/xlsx recusa 502 quando ml_accounts falha com ?conta= preenchida", async () => {
    const { db, rpcs } = makeDb({
      tables: { ml_accounts: { data: null, error: { message: "db indisponível" } } },
    });
    m.createClient.mockResolvedValue(db);

    const response = await exportarPrecos(
      new Request("http://localhost/precos/export/xlsx?conta=aaaaaaaa-0000-4000-8000-000000000001"),
    );

    expect(response.status).toBe(502);
    expect(rpcs).not.toContain("get_price_changes");
  });

  it("rotas CSV devolvem 503 (não 403 'sem organização') quando get_current_membership falha no banco", async () => {
    const erroMembership = { data: null, error: { message: "connection reset" } };

    for (const [nome, chamar] of [
      ["/anuncios/exportar", () => exportarAnuncios(new NextRequest("http://localhost/anuncios/exportar"))],
      ["/anuncios/shopee/exportar", () => exportarAnunciosShopee(new NextRequest("http://localhost/anuncios/shopee/exportar"))],
      ["/full/exportar", () => exportarFull(new NextRequest("http://localhost/full/exportar"))],
      ["/vendas/exportar (todos)", () => exportarVendas(new NextRequest("http://localhost/vendas/exportar?tabela=dia&marketplace=todos"))],
      ["/vendas/exportar (ml)", () => exportarVendas(new NextRequest("http://localhost/vendas/exportar?tabela=dia&marketplace=ml"))],
      ["/vendas/shopee/exportar", () => exportarVendasShopee(new NextRequest("http://localhost/vendas/shopee/exportar"))],
    ] as const) {
      const { db } = makeDb({ membershipResult: erroMembership });
      m.createClient.mockResolvedValue(db);

      const response = await chamar();

      expect(response.status, nome).toBe(503);
    }
  });
});
