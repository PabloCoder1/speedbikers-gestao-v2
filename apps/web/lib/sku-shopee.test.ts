import { describe, expect, it } from "vitest";

import { hrefDoPedidoShopee } from "./shopee-sales";
import { PEDIDOS_DO_SKU_POR_PAGINA, hrefDaPaginaDosPedidos, janelaDosPedidos, paginaDosPedidos } from "./sku-shopee";

describe("paginaDosPedidos", () => {
  it("lê o inteiro da URL, e qualquer outra coisa é a primeira página", () => {
    expect(paginaDosPedidos("3")).toBe(3);
    expect(paginaDosPedidos(undefined)).toBe(1);
    expect(paginaDosPedidos("0")).toBe(1);
    expect(paginaDosPedidos("-2")).toBe(1);
    expect(paginaDosPedidos("2.5")).toBe(1);
    expect(paginaDosPedidos("abc")).toBe(1);
    expect(paginaDosPedidos(["2", "3"])).toBe(1);
  });
});

describe("hrefDaPaginaDosPedidos", () => {
  it("fica na aba Vendas do SKU, e a primeira página não leva o parâmetro", () => {
    expect(hrefDaPaginaDosPedidos("sku-1", 1)).toBe("/skus/sku-1?aba=vendas");
    expect(hrefDaPaginaDosPedidos("sku-1", 2)).toBe("/skus/sku-1?aba=vendas&pedidos=2");
  });
});

describe("janelaDosPedidos", () => {
  it("diz a janela da página com o total que veio do banco", () => {
    const janela = janelaDosPedidos(2, PEDIDOS_DO_SKU_POR_PAGINA + 5, 5);

    expect(janela.totalPages).toBe(2);
    expect(janela.label).toContain("25");
  });
});

describe("hrefDoPedidoShopee", () => {
  it("abre o pedido na /vendas/shopee, na loja e no dia dele", () => {
    expect(hrefDoPedidoShopee("loja-1", "2026-10-19", "E2ELIVE01")).toBe(
      "/vendas/shopee?loja=loja-1&from=2026-10-19&to=2026-10-19&pedido=E2ELIVE01",
    );
  });

  it("sem loja, com dia fora do formato ou sem pedido, não há link: a referência fica texto", () => {
    expect(hrefDoPedidoShopee(null, "2026-10-19", "E2ELIVE01")).toBeNull();
    expect(hrefDoPedidoShopee("loja-1", null, "E2ELIVE01")).toBeNull();
    expect(hrefDoPedidoShopee("loja-1", "19/10/2026", "E2ELIVE01")).toBeNull();
    expect(hrefDoPedidoShopee("loja-1", "2026-10-19", " ")).toBeNull();
  });
});
