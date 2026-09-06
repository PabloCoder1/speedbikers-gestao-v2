import { describe, expect, it } from "vitest";

import {
  PAGE_SIZE,
  PURCHASE_ORDER_STATUSES,
  buildPurchaseOrderHref,
  resolvePurchaseOrderFilters,
  resolvePurchaseOrderStatus,
  summarizePurchaseOrderWindow,
  type PurchaseOrderFilters,
} from "./purchase-order-filters";

const base: PurchaseOrderFilters = { status: null, search: null, page: 1 };

describe("estado do pedido", () => {
  it("resolve os cinco estados do ciclo", () => {
    for (const estado of PURCHASE_ORDER_STATUSES) {
      expect(resolvePurchaseOrderStatus(estado)).toBe(estado);
    }
  });

  /**
   * O brief §23 pede sete estados e o frame desenha "Recebimento Parcial" — a
   * `check` constraint de `purchase_orders` conhece cinco. Um estado que o
   * banco recusa não pode virar filtro: iria ao banco e voltaria vazio, o que
   * se lê como "não há pedidos assim" em vez de "esse estado não existe".
   */
  it("os estados que o brief pede e o banco não tem viram nulo", () => {
    expect(resolvePurchaseOrderStatus("EM_TRANSITO")).toBeNull();
    expect(resolvePurchaseOrderStatus("RECEBIDO_PARCIALMENTE")).toBeNull();
    expect(resolvePurchaseOrderStatus("PARTIAL")).toBeNull();
    expect(resolvePurchaseOrderStatus("draft")).toBeNull();
    expect(resolvePurchaseOrderStatus(undefined)).toBeNull();
  });

  it("a lista fechada tem exatamente os cinco da constraint", () => {
    expect([...PURCHASE_ORDER_STATUSES]).toEqual([
      "DRAFT",
      "APPROVED",
      "ORDERED",
      "RECEIVED",
      "CANCELLED",
    ]);
  });
});

describe("resolução da URL", () => {
  it("lê estado, busca e página", () => {
    expect(resolvePurchaseOrderFilters({ estado: "ORDERED", busca: "  plasmoto ", pagina: "2" })).toEqual(
      { status: "ORDERED", search: "plasmoto", page: 2 },
    );
  });

  it("busca só de espaço não vira filtro", () => {
    expect(resolvePurchaseOrderFilters({ busca: "   " }).search).toBeNull();
  });

  it("página inválida cai em 1", () => {
    expect(resolvePurchaseOrderFilters({ pagina: "-3" }).page).toBe(1);
  });
});

describe("href", () => {
  it("o default fica FORA da URL", () => {
    expect(buildPurchaseOrderHref(base, {})).toBe("/compras");
  });

  it("trocar de filtro volta para a página 1; paginar preserva o recorte", () => {
    const atual: PurchaseOrderFilters = { status: "DRAFT", search: "givi", page: 3 };

    expect(buildPurchaseOrderHref(atual, { status: "RECEIVED" })).toBe(
      "/compras?estado=RECEIVED&busca=givi",
    );
    expect(buildPurchaseOrderHref(atual, { page: 4 })).toBe(
      "/compras?estado=DRAFT&busca=givi&pagina=4",
    );
  });
});

describe("janela declarada", () => {
  /**
   * O defeito que a tela tinha: `.limit(100)` e um rodapé "{data.length}
   * pedido(s)". Com 137 pedidos ele dizia "100 pedido(s)" — afirmando como
   * TOTAL o que era só o tamanho da página (D-131).
   */
  it("com mais pedidos que a página, a frase declara o corte", () => {
    const janela = summarizePurchaseOrderWindow(1, 137, PAGE_SIZE);

    expect(janela.label).toBe("Mostrando 1 a 50 de 137 pedidos.");
    expect(janela.totalPages).toBe(3);
  });

  it("flexiona pelo total — o 'pedido(s)' some", () => {
    expect(summarizePurchaseOrderWindow(1, 1, 1).label).toBe("1 pedido.");
    expect(summarizePurchaseOrderWindow(1, 4, 4).label).toBe("4 pedidos.");
  });

  it("vazio diz por que está vazio", () => {
    expect(summarizePurchaseOrderWindow(1, 0, 0).label).toBe(
      "Nenhum pedido de compra com estes filtros.",
    );
  });
});
