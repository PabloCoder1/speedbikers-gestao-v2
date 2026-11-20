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
  const inChamadas: { tabela: string; coluna: string; tamanho: number }[] = [];
  const TETO = 1000;
  const resposta = (tabela: string, data: Record<string, unknown>[]) => {
    let filtroIn: { coluna: string; valores: Set<unknown> } | null = null;
    let faixa: [number, number] | null = null;
    const cadeia: Record<string, unknown> = {
      eq: () => cadeia,
      in: (coluna: string, valores: unknown[]) => {
        inChamadas.push({ tabela, coluna, tamanho: valores.length });
        filtroIn = { coluna, valores: new Set(valores) };

        return cadeia;
      },
      order: () => cadeia,
      range: (from: number, to: number) => {
        faixa = [from, to];

        return cadeia;
      },
      then: (resolve: (v: unknown) => void) => {
        const filtradas = filtroIn === null ? data : data.filter((row) => filtroIn!.valores.has(row[filtroIn!.coluna]));
        const pagina =
          faixa === null
            ? filtradas.slice(0, TETO)
            : filtradas.slice(faixa[0], Math.min(faixa[1] + 1, faixa[0] + TETO));

        resolve({ data: pagina, error: null });
      },
    };

    return cadeia;
  };

  const db = {
    from: (tabela: string) => ({
      select: () => {
        lidas.push(tabela);

        if (tabela === "shopee_orders") return resposta(tabela, f.pedidos ?? []);
        if (tabela === "shopee_order_items") return resposta(tabela, f.itens ?? []);
        if (tabela === "skus") return resposta(tabela, f.skus ?? []);
        if (tabela === "stock_movements") return resposta(tabela, f.gravadas ?? []);

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

  return { db: db as never, upserts, lidas, inChamadas };
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

  it("D-772: pagina shopee_order_items e stock_movements além de 1.000 linhas sem truncar estornos", async () => {
    const TOTAL = 1005;
    const itens = Array.from({ length: TOTAL }, (_, pos) => ({
      order_sn: "BIG-1",
      position: pos,
      quantity: 1,
      sku_id: "sku-novo",
    }));
    const gravadas = Array.from({ length: TOTAL }, (_, pos) => ({
      id: pos + 1,
      source_id: "BIG-1",
      idempotency_key: `shopee-venda:${LOJA.id}:BIG-1:${String(pos)}`,
      sku_id: "sku-antigo",
      qty_delta: -3,
      occurred_at: "2026-10-20T14:00:00.000Z",
      created_at: "2026-10-20T14:05:00.000Z",
    }));
    const { db, upserts } = fakeDb({
      pedidos: [
        pedido("BIG-1", {
          order_status: "CANCELLED",
          paid_at: "2026-10-20T14:00:00.000Z",
          shopee_updated_at: "2026-10-20T15:00:00.000Z",
        }),
      ],
      itens,
      skus: [{ id: "sku-novo", kind: "PRODUTO", sku_components: [] }],
      gravadas,
    });

    await baixarVendasDaShopee(db, LOJA, ["BIG-1"]);
    const movimentos = upserts.flat();

    expect(
      movimentos.filter(
        (m) => m.movement_type === "CANCELAMENTO_SHOPEE" && m.sku_id === "sku-antigo" && m.qty_delta === 3,
      ),
    ).toHaveLength(TOTAL);
  });

  it("D-772: fatia .in() de skus em lotes de até 100 UUIDs e order_sn em lotes de até 200", async () => {
    const pedidos = Array.from({ length: 250 }, (_, i) => pedido(`SN-${String(i)}`));
    const itens = Array.from({ length: 250 }, (_, i) => ({
      order_sn: `SN-${String(i)}`,
      position: 0,
      quantity: 1,
      sku_id: `sku-${String(i)}`,
    }));
    const skus = Array.from({ length: 250 }, (_, i) => ({
      id: `sku-${String(i)}`,
      kind: "PRODUTO",
      sku_components: [],
    }));
    const { db, inChamadas, upserts } = fakeDb({ pedidos, itens, skus });

    const total = await baixarVendasDaShopee(
      db,
      LOJA,
      pedidos.map((p) => p.order_sn),
    );

    expect(total).toBe(250);
    expect(upserts.flat()).toHaveLength(250);

    const skuIn = inChamadas.filter((c) => c.tabela === "skus" && c.coluna === "id");
    const orderIn = inChamadas.filter((c) => c.tabela === "shopee_orders" && c.coluna === "order_sn");

    expect(skuIn.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...skuIn.map((c) => c.tamanho))).toBeLessThanOrEqual(100);
    expect(orderIn.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...orderIn.map((c) => c.tamanho))).toBeLessThanOrEqual(200);
  });
});
