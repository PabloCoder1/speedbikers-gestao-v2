import { describe, expect, it } from "vitest";

import { baixarVendasDaShopee } from "./shopee-stock.js";

const ORG = "11111111-0000-4000-8000-000000000001";
const LOJA = { id: "aaaa4951-0000-4000-8000-00000000a495", organization_id: ORG, environment: "live" };
const EXPORTADA = "2026-10-20T12:00:00.000Z";

interface Fake {
  pedidos?: Record<string, unknown>[];
  itens?: Record<string, unknown>[];
  skus?: Record<string, unknown>[];
  gravadas?: Record<string, unknown>[];
  cortes?: Record<string, unknown>[];
  erroNoUpsert?: { code: string; message: string };
}

/** Banco falso: cada tabela devolve o que o teste deu; o upsert do ledger é capturado. */
function fakeDb(f: Fake) {
  const upserts: Record<string, unknown>[][] = [];
  const lidas: string[] = [];
  const resposta = (data: unknown) => {
    const r = { data, error: null };
    const cadeia: Record<string, unknown> = {
      eq: () => cadeia,
      in: () => cadeia,
      then: (resolve: (v: unknown) => void) => {
        resolve(r);
      },
    };

    return cadeia;
  };

  const db = {
    from: (tabela: string) => ({
      select: () => {
        lidas.push(tabela);

        if (tabela === "shopee_orders") return resposta(f.pedidos ?? []);
        if (tabela === "shopee_order_items") return resposta(f.itens ?? []);
        if (tabela === "skus") return resposta(f.skus ?? []);
        if (tabela === "stock_movements") return resposta(f.gravadas ?? []);

        throw new Error(`tabela inesperada: ${tabela}`);
      },
      upsert: (linhas: Record<string, unknown>[]) => {
        upserts.push(linhas);

        return Promise.resolve({ error: f.erroNoUpsert ?? null });
      },
    }),
    rpc: (nome: string, args: { p_sku_ids: string[] }) => {
      if (nome !== "get_erp_stock_cutoffs") throw new Error(`rpc inesperada: ${nome}`);

      return Promise.resolve({
        data: args.p_sku_ids.map(
          (sku) =>
            f.cortes?.find((c) => c.sku_id === sku) ?? {
              sku_id: sku,
              captured_at: EXPORTADA,
              exported_at: EXPORTADA,
              imported_at: "2026-10-20T13:00:00.000Z",
              reconciled_at: null,
            },
        ),
        error: null,
      });
    },
  };

  return { db: db as never, upserts, lidas };
}

const pedido = (sn: string, extra: Record<string, unknown> = {}) => ({
  order_sn: sn,
  order_status: "READY_TO_SHIP",
  paid_at: "2026-10-20T14:00:00.000Z",
  shopee_updated_at: "2026-10-20T14:00:00.000Z",
  fulfillment_flag: "fulfilled_by_local_seller",
  ...extra,
});

describe("baixarVendasDaShopee (D-495)", () => {
  it("loja que não é live não lê nem grava nada", async () => {
    const { db, upserts, lidas } = fakeDb({ pedidos: [pedido("A1")] });

    expect(await baixarVendasDaShopee(db, { ...LOJA, environment: "sandbox" }, ["A1"])).toBe(0);
    expect(lidas).toEqual([]);
    expect(upserts).toEqual([]);
  });

  it("grava a venda com a origem SHOPEE_ORDER e o order_sn, num upsert que não reescreve", async () => {
    const { db, upserts } = fakeDb({
      pedidos: [pedido("A1")],
      itens: [{ order_sn: "A1", position: 0, quantity: 2, sku_id: "sku-1" }],
      skus: [{ id: "sku-1", kind: "PRODUTO", sku_components: [] }],
    });

    expect(await baixarVendasDaShopee(db, LOJA, ["A1"])).toBe(1);
    expect(upserts).toEqual([
      [
        {
          organization_id: ORG,
          sku_id: "sku-1",
          location_kind: "LOCAL",
          qty_delta: -2,
          movement_type: "VENDA_SHOPEE",
          source_type: "SHOPEE_ORDER",
          source_id: "A1",
          idempotency_key: `shopee-venda:${LOJA.id}:A1:0`,
          occurred_at: "2026-10-20T14:00:00.000Z",
        },
      ],
    ]);
  });

  it("o kit baixa os componentes; o armazém da Shopee ganha o par; o cancelado depois do corte repõe", async () => {
    const { db, upserts } = fakeDb({
      pedidos: [
        pedido("K1"),
        pedido("F1", { fulfillment_flag: "fulfilled_by_shopee" }),
        pedido("C1", { order_status: "CANCELLED", shopee_updated_at: "2026-10-20T15:00:00.000Z" }),
      ],
      itens: [
        { order_sn: "K1", position: 0, quantity: 1, sku_id: "kit-1" },
        { order_sn: "F1", position: 0, quantity: 1, sku_id: "sku-1" },
        { order_sn: "C1", position: 0, quantity: 1, sku_id: "sku-1" },
      ],
      skus: [
        { id: "kit-1", kind: "KIT", sku_components: [{ component_sku_id: "c-1", quantity: 2 }] },
        { id: "sku-1", kind: "PRODUTO", sku_components: [] },
      ],
    });

    await baixarVendasDaShopee(db, LOJA, ["K1", "F1", "C1"]);

    const porTipo = (upserts[0] ?? []).map((l) => [l.movement_type, l.source_id, l.sku_id, l.qty_delta]);

    expect(porTipo).toEqual(
      expect.arrayContaining([
        ["VENDA_SHOPEE", "K1", "c-1", -2],
        ["VENDA_SHOPEE", "F1", "sku-1", -1],
        ["ESTORNO_ARMAZEM_SHOPEE", "F1", "sku-1", 1],
        ["VENDA_SHOPEE", "C1", "sku-1", -1],
        ["CANCELAMENTO_SHOPEE", "C1", "sku-1", 1],
      ]),
    );
    expect(porTipo).toHaveLength(5);
    // Por SKU, como o lote do ML: o gatilho do saldo trava sempre na mesma ordem.
    const skus = (upserts[0] ?? []).map((l) => String(l.sku_id));

    expect(skus).toEqual([...skus].sort());
  });

  it("SKU do item que não foi lido LANÇA: cair em PRODUTO baixaria a linha do kit", async () => {
    const { db } = fakeDb({
      pedidos: [pedido("A1")],
      itens: [{ order_sn: "A1", position: 0, quantity: 1, sku_id: "sumiu" }],
      skus: [],
    });

    await expect(baixarVendasDaShopee(db, LOJA, ["A1"])).rejects.toThrow(/SKU sumiu/);
  });

  it("falha ao gravar o ledger LANÇA; a chave repetida (23505) é a idempotência", async () => {
    const base = {
      pedidos: [pedido("A1")],
      itens: [{ order_sn: "A1", position: 0, quantity: 1, sku_id: "sku-1" }],
      skus: [{ id: "sku-1", kind: "PRODUTO", sku_components: [] }],
    };

    await expect(baixarVendasDaShopee(fakeDb({ ...base, erroNoUpsert: { code: "23514", message: "check" } }).db, LOJA, ["A1"])).rejects.toThrow(
      /stock_movements/,
    );
    await expect(baixarVendasDaShopee(fakeDb({ ...base, erroNoUpsert: { code: "23505", message: "dup" } }).db, LOJA, ["A1"])).resolves.toBe(1);
  });
});
