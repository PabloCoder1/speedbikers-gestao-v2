import { describe, expect, it } from "vitest";

import { flushPageWrites, novaPagina } from "./page-writes.js";

const ORG = "11111111-0000-4000-8000-000000000001";

interface Chamada {
  table: string;
  verbo: string;
  rows: unknown;
  filtros: Record<string, unknown>;
}

/**
 * Fake mínimo que REGISTRA as chamadas — é o que se está testando aqui: não o
 * conteúdo de uma linha, e sim QUANTAS idas ao banco a página custa e em que
 * ordem elas acontecem.
 */
function dbFalso(erroEm?: string) {
  const chamadas: Chamada[] = [];

  const resposta = (table: string) =>
    Promise.resolve(
      erroEm === table ? { data: null, error: { code: "42P01", message: "boom" } } : { data: null, error: null },
    );

  const db = {
    from: (table: string) => ({
      upsert: (rows: unknown) => {
        chamadas.push({ table, verbo: "upsert", rows, filtros: {} });

        return resposta(table);
      },
      delete: () => {
        interface CadeiaDelete {
          in: (col: string, val: unknown) => CadeiaDelete;
          gte: (col: string, val: unknown) => CadeiaDelete;
          then: <T>(onFulfilled: (value: { data: null; error: unknown }) => T) => Promise<T>;
        }

        const cadeia = (filtros: Record<string, unknown>): CadeiaDelete => ({
          in: (col: string, val: unknown) => cadeia({ ...filtros, [col]: val }),
          gte: (col: string, val: unknown) => cadeia({ ...filtros, [`${col}>=`]: val }),
          then: <T>(onFulfilled: (value: { data: null; error: unknown }) => T) => {
            chamadas.push({ table, verbo: "delete", rows: null, filtros });

            return resposta(table).then(onFulfilled);
          },
        });

        return cadeia({});
      },
    }),
  } as unknown as Parameters<typeof flushPageWrites>[0];

  return { db, chamadas };
}

function itemDe(orderId: number, position = 0): Record<string, unknown> {
  return {
    order_id: orderId,
    organization_id: ORG,
    ml_account_id: "aaaa",
    position,
    item_id: `MLB${String(orderId)}`,
    quantity: 1,
    unit_price: 10,
    currency_id: "BRL",
  };
}

function movimentoDe(skuId: string) {
  return {
    draft: { skuId, qtyDelta: -1, idempotencyKey: `venda:${skuId}`, occurredAt: new Date("2026-09-01T00:00:00Z") },
    movementType: "VENDA_ML",
    source: { type: "ORDER", id: "1" },
  };
}

describe("escritas em lote por página (D-190)", () => {
  it("uma página de 50 pedidos custa QUATRO idas, não 200", async () => {
    const writes = novaPagina(ORG);

    for (let i = 1; i <= 50; i += 1) {
      writes.orders.push({ id: i, organization_id: ORG, ml_account_id: "aaaa" } as never);
      writes.items.push(itemDe(i) as never);
      writes.tails.push({ orderId: i, fromPosition: 1 });
      writes.movements.push(movimentoDe(`sku-${String(i)}`));
    }

    const { db, chamadas } = dbFalso();

    await flushPageWrites(db, writes);

    // É esta a propriedade pela qual o módulo existe. Antes eram quatro
    // escritas POR PEDIDO.
    expect(chamadas.map((c) => `${c.table}.${c.verbo}`)).toEqual([
      "orders.upsert",
      "order_items.upsert",
      "order_items.delete",
      "stock_movements.upsert",
    ]);
  });

  it("grava `orders` ANTES de `order_items` — a FK exige o pedido existindo", async () => {
    const writes = novaPagina(ORG);

    writes.orders.push({ id: 1, organization_id: ORG } as never);
    writes.items.push(itemDe(1) as never);

    const { db, chamadas } = dbFalso();

    await flushPageWrites(db, writes);

    expect(chamadas.findIndex((c) => c.table === "orders")).toBeLessThan(
      chamadas.findIndex((c) => c.table === "order_items"),
    );
  });

  it("o mesmo pedido duas vezes na página não quebra o upsert — fica a ÚLTIMA versão", async () => {
    // `ON CONFLICT DO UPDATE` falha com "cannot affect row a second time" se a
    // mesma chave aparecer duas vezes no MESMO comando. Sequencialmente isso
    // nunca foi problema (dois comandos); em lote é. O Mercado Livre pagina
    // por offset, e uma order atualizada durante a varredura pode repetir.
    const writes = novaPagina(ORG);

    writes.orders.push({ id: 7, organization_id: ORG, status: "paid" } as never);
    writes.orders.push({ id: 7, organization_id: ORG, status: "cancelled" } as never);
    writes.items.push(itemDe(7) as never);
    writes.items.push({ ...itemDe(7), quantity: 99 } as never);

    const { db, chamadas } = dbFalso();

    await flushPageWrites(db, writes);

    const orders = chamadas.find((c) => c.table === "orders")?.rows as { status: string }[];
    const items = chamadas.find((c) => c.table === "order_items" && c.verbo === "upsert")?.rows as {
      quantity: number;
    }[];

    // Uma linha só, e é a última — que é o que a forma sequencial produzia:
    // a segunda gravação sobrescrevia a primeira.
    expect(orders).toHaveLength(1);
    expect(orders[0]?.status).toBe("cancelled");
    expect(items).toHaveLength(1);
    expect(items[0]?.quantity).toBe(99);
  });

  it("os movimentos vão ORDENADOS por sku — é a correção do deadlock, não arrumação", async () => {
    // O trigger `apply_to_balance` é AFTER INSERT FOR EACH ROW e trava a linha
    // de saldo de cada SKU. N linhas num statement seguram N travas, na ordem
    // em que aparecem; dois lotes concorrentes em ordens diferentes formam
    // ciclo. Ordenar faz todo lote adquirir na mesma ordem.
    const writes = novaPagina(ORG);

    writes.movements.push(movimentoDe("sku-c"), movimentoDe("sku-a"), movimentoDe("sku-b"));

    const { db, chamadas } = dbFalso();

    await flushPageWrites(db, writes);

    const linhas = chamadas.find((c) => c.table === "stock_movements")?.rows as { sku_id: string }[];

    expect(linhas.map((linha) => linha.sku_id)).toEqual(["sku-a", "sku-b", "sku-c"]);
  });

  it("a exclusão da cauda é agrupada por posição de corte, não uma por pedido", async () => {
    const writes = novaPagina(ORG);

    // Quase sempre um grupo só: todo pedido tem 1 item (D-184). Aqui, dois
    // grupos, para provar que a forma não supõe contagem uniforme.
    writes.tails.push({ orderId: 1, fromPosition: 1 }, { orderId: 2, fromPosition: 1 }, { orderId: 3, fromPosition: 2 });

    const { db, chamadas } = dbFalso();

    await flushPageWrites(db, writes);

    const exclusoes = chamadas.filter((c) => c.verbo === "delete");

    expect(exclusoes).toHaveLength(2);
    expect(exclusoes[0]?.filtros).toEqual({ order_id: [1, 2], "position>=": 1 });
    expect(exclusoes[1]?.filtros).toEqual({ order_id: [3], "position>=": 2 });
  });

  it("falha na gravação dos pedidos ABORTA antes de tocar nos itens", async () => {
    const writes = novaPagina(ORG);

    writes.orders.push({ id: 1, organization_id: ORG } as never);
    writes.items.push(itemDe(1) as never);

    const { db, chamadas } = dbFalso("orders");

    await expect(flushPageWrites(db, writes)).rejects.toThrow(/orders\.upsert em lote/);

    expect(chamadas.map((c) => c.table)).toEqual(["orders"]);
  });

  it("falha na gravação dos movimentos ABORTA — é o saldo, não telemetria (D-187)", async () => {
    const writes = novaPagina(ORG);

    writes.movements.push(movimentoDe("sku-a"));

    const { db } = dbFalso("stock_movements");

    await expect(flushPageWrites(db, writes)).rejects.toThrow(/stock_movements\.upsert em lote/);
  });

  it("página vazia não vai ao banco", async () => {
    const { db, chamadas } = dbFalso();

    await flushPageWrites(db, novaPagina(ORG));

    expect(chamadas).toEqual([]);
  });
});
