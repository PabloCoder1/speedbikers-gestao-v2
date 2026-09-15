import { describe, expect, it } from "vitest";

import { ensureSupportLink } from "./support-case-links.js";

type Row = Record<string, unknown>;

const BASE = {
  organization_id: "11111111-0000-4000-8000-000000000001",
  ml_account_id: "aaaaaaaa-0000-4000-8000-000000000001",
  support_case_id: "case-1",
  link_source: "REMOTE",
};

function fakeDb(
  options: { existing?: Row[]; lookupError?: string; insertError?: { code: string; message: string } } = {},
) {
  const lookups: Row[] = [];
  const inserts: Row[] = [];

  const db = {
    from(table: string) {
      if (table !== "support_case_links") {
        throw new Error(`tabela inesperada: ${table}`);
      }

      return {
        select: () => {
          const filters: Row = {};
          const chain = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return chain;
            },
            maybeSingle: () => {
              lookups.push({ ...filters });

              if (options.lookupError !== undefined) {
                return Promise.resolve({ data: null, error: { message: options.lookupError } });
              }

              const found = (options.existing ?? []).some((row) =>
                Object.entries(filters).every(([column, value]) => row[column] === value),
              );

              return Promise.resolve({ data: found ? { id: "link-1" } : null, error: null });
            },
          };

          return chain;
        },
        insert: (row: Row) => {
          inserts.push(row);
          return Promise.resolve({ data: null, error: options.insertError ?? null });
        },
      };
    },
  };

  return { db: db as never, lookups, inserts };
}

describe("ensureSupportLink (D-353)", () => {
  it("vínculo que já existe não tenta INSERT — era esse 23505 que enchia o log do Postgres", async () => {
    const fake = fakeDb({ existing: [{ support_case_id: "case-1", order_id: 2000007819609432 }] });

    await ensureSupportLink(fake.db, { ...BASE, order_id: 2000007819609432 });

    expect(fake.inserts).toHaveLength(0);
  });

  it("vínculo novo é inserido", async () => {
    const fake = fakeDb();

    await ensureSupportLink(fake.db, { ...BASE, order_id: 2000007819609432 });

    expect(fake.inserts).toEqual([{ ...BASE, order_id: 2000007819609432 }]);
  });

  it.each([
    ["pedido", { order_id: 2000007819609432 }],
    ["SKU", { sku_id: "sku-1" }],
    ["anúncio", { listing_id: "listing-1" }],
    ["externo", { external_entity_kind: "ORDER", external_entity_id: "2000007819609432" }],
  ])("vínculo de %s consulta pela chave do SEU índice parcial, e só por ela", async (_label, target) => {
    const fake = fakeDb();

    await ensureSupportLink(fake.db, { ...BASE, ...target });

    expect(fake.lookups).toEqual([{ support_case_id: "case-1", ...target }]);
  });

  it("outro alvo do mesmo case não conta como vínculo existente", async () => {
    const fake = fakeDb({ existing: [{ support_case_id: "case-1", order_id: 2000007819609432 }] });

    await ensureSupportLink(fake.db, { ...BASE, sku_id: "sku-1", link_source: "ORDER_DERIVED" });

    expect(fake.inserts).toHaveLength(1);
  });

  it("a corrida entre a consulta e o INSERT (23505) continua tolerada", async () => {
    const fake = fakeDb({ insertError: { code: "23505", message: "duplicate key" } });

    await expect(ensureSupportLink(fake.db, { ...BASE, sku_id: "sku-1" })).resolves.toBeUndefined();
  });

  it("outro erro no INSERT propaga", async () => {
    const fake = fakeDb({ insertError: { code: "23503", message: "violates foreign key" } });

    await expect(ensureSupportLink(fake.db, { ...BASE, order_id: 1 })).rejects.toThrow(
      /gravar vínculo do atendimento: violates foreign key/,
    );
  });

  it("erro na consulta propaga e não arrisca o INSERT", async () => {
    const fake = fakeDb({ lookupError: "conexão perdida" });

    await expect(ensureSupportLink(fake.db, { ...BASE, listing_id: "listing-1" })).rejects.toThrow(
      /consultar vínculo do atendimento: conexão perdida/,
    );
    expect(fake.inserts).toHaveLength(0);
  });
});
