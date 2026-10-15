import { describe, expect, it } from "vitest";

import {
  SHOPEE_ORDERS_PAGE_SIZE,
  SHOPEE_SALES_METRICS,
  SHOPEE_SITUACOES,
  buildShopeeSalesHref,
  lojaDeTesteShopee,
  nomeDaLojaShopee,
  origemDoSkuShopee,
  parseShopeeOrderItems,
  resolveShopeeSalesFilters,
  shopeeSituacao,
  summarizeShopeeOrdersWindow,
} from "./shopee-sales";

const LOJA = "5b1d0000-0000-4000-8000-000000000001";
const HOJE = "2026-10-14";

describe("resolveShopeeSalesFilters", () => {
  it("URL vazia: últimos 30 dias até hoje, sem loja nem situação, página 1", () => {
    expect(resolveShopeeSalesFilters({}, [LOJA], HOJE)).toEqual({
      filters: { range: { from: "2026-09-15", to: HOJE }, days: 30, loja: null, situacao: null, pagina: 1, pedido: null },
      invalidCustom: false,
    });
  });

  it("o período é o vocabulário de /vendas: preset fora da lista cai no padrão", () => {
    expect(resolveShopeeSalesFilters({ days: "7" }, [], HOJE).filters).toMatchObject({
      days: 7,
      range: { from: "2026-10-08", to: HOJE },
    });
    expect(resolveShopeeSalesFilters({ days: "14" }, [], HOJE).filters.days).toBe(30);
  });

  it("período personalizado vale; invertido cai no padrão e avisa", () => {
    expect(resolveShopeeSalesFilters({ from: "2026-10-01", to: "2026-10-05" }, [], HOJE)).toMatchObject({
      filters: { days: null, range: { from: "2026-10-01", to: "2026-10-05" } },
      invalidCustom: false,
    });
    expect(resolveShopeeSalesFilters({ from: "2026-10-05", to: "2026-10-01" }, [], HOJE)).toMatchObject({
      filters: { days: 30 },
      invalidCustom: true,
    });
  });

  it("aceita só loja da organização e situação do conjunto fechado", () => {
    expect(resolveShopeeSalesFilters({ loja: LOJA, situacao: "canceladas" }, [LOJA], HOJE).filters).toMatchObject({
      loja: LOJA,
      situacao: "canceladas",
    });
    expect(
      resolveShopeeSalesFilters({ loja: "5b1d0000-0000-4000-8000-000000000999", situacao: "CANCELADA" }, [LOJA], HOJE)
        .filters,
    ).toMatchObject({ loja: null, situacao: null });
  });

  it("página inválida cai em 1; página enorme é presa antes de estourar o offset", () => {
    expect(resolveShopeeSalesFilters({ pagina: "-2" }, [], HOJE).filters.pagina).toBe(1);
    expect(resolveShopeeSalesFilters({ pagina: "3" }, [], HOJE).filters.pagina).toBe(3);
    expect(
      resolveShopeeSalesFilters({ pagina: "999999999999" }, [], HOJE).filters.pagina * SHOPEE_ORDERS_PAGE_SIZE,
    ).toBeLessThanOrEqual(2_147_483_647);
  });
});

describe("o pedido que a Busca Universal abriu (D-476)", () => {
  it("?pedido= vale com letra, dígito e hífen, de 2 a 40 — a regra da busca no banco", () => {
    expect(resolveShopeeSalesFilters({ pedido: "2510150ABCDEF" }, [], HOJE).filters.pedido).toBe("2510150ABCDEF");
    expect(resolveShopeeSalesFilters({ pedido: " E2E-SHP-CANCELADO " }, [], HOJE).filters.pedido).toBe("E2E-SHP-CANCELADO");
  });

  it("fora da regra não vira filtro: a lista de sempre, nunca uma busca que o banco recusaria", () => {
    expect(resolveShopeeSalesFilters({ pedido: "a" }, [], HOJE).filters.pedido).toBeNull();
    expect(resolveShopeeSalesFilters({ pedido: "x' or 1=1" }, [], HOJE).filters.pedido).toBeNull();
    expect(resolveShopeeSalesFilters({ pedido: "x".repeat(41) }, [], HOJE).filters.pedido).toBeNull();
    expect(resolveShopeeSalesFilters({}, [], HOJE).filters.pedido).toBeNull();
  });

  it("o pedido viaja com os outros filtros, e tirá-lo devolve a lista", () => {
    const comPedido = resolveShopeeSalesFilters(
      { from: "2026-10-10", to: "2026-10-10", loja: LOJA, pedido: "2510100ABC" },
      [LOJA],
      HOJE,
    ).filters;

    expect(buildShopeeSalesHref(comPedido, { situacao: "validas" })).toBe(
      `/vendas/shopee?from=2026-10-10&to=2026-10-10&loja=${LOJA}&situacao=validas&pedido=2510100ABC`,
    );
    expect(buildShopeeSalesHref(comPedido, { pedido: null })).toBe(`/vendas/shopee?from=2026-10-10&to=2026-10-10&loja=${LOJA}`);
  });
});

describe("buildShopeeSalesHref", () => {
  const base = resolveShopeeSalesFilters({ days: "7", loja: LOJA, situacao: "validas", pagina: "3" }, [LOJA], HOJE)
    .filters;

  it("trocar um filtro preserva os outros e volta à página 1", () => {
    expect(buildShopeeSalesHref(base, { situacao: "canceladas" })).toBe(
      `/vendas/shopee?days=7&loja=${LOJA}&situacao=canceladas`,
    );
    expect(buildShopeeSalesHref(base, { loja: null })).toBe("/vendas/shopee?days=7&situacao=validas");
  });

  it("a paginação leva todos os filtros junto", () => {
    expect(buildShopeeSalesHref(base, { pagina: 4 })).toBe(`/vendas/shopee?days=7&loja=${LOJA}&situacao=validas&pagina=4`);
  });

  it("o período padrão fica fora da URL; o personalizado viaja como from/to", () => {
    expect(buildShopeeSalesHref(base, { days: 30, loja: null, situacao: null })).toBe("/vendas/shopee");

    const personalizado = resolveShopeeSalesFilters({ from: "2026-10-01", to: "2026-10-05" }, [], HOJE).filters;

    expect(buildShopeeSalesHref(personalizado, { situacao: "nao-pagas" })).toBe(
      "/vendas/shopee?from=2026-10-01&to=2026-10-05&situacao=nao-pagas",
    );
    // Escolher um preset larga o personalizado.
    expect(buildShopeeSalesHref(personalizado, { days: 90 })).toBe("/vendas/shopee?days=90");
  });
});

describe("situações e origem do SKU", () => {
  it("as três situações espelham o case da view", () => {
    expect(SHOPEE_SITUACOES.map((s) => s.codigo)).toEqual(["VALIDA", "CANCELADA", "NAO_PAGA"]);
    expect(shopeeSituacao("CANCELADA")?.rotulo).toBe("Cancelada");
    expect(shopeeSituacao("OUTRA")).toBeNull();
  });

  it("origem do SKU com os rótulos de /anuncios/shopee; nulo é sem SKU", () => {
    expect(origemDoSkuShopee("MANUAL")).toBe("vínculo manual");
    expect(origemDoSkuShopee("SKU_DO_ANUNCIO")).toBe("pelo SKU do anúncio");
    expect(origemDoSkuShopee("SKU_DO_PEDIDO")).toBe("SKU do pedido");
    expect(origemDoSkuShopee("NOVA_ORIGEM")).toBe("NOVA_ORIGEM");
    expect(origemDoSkuShopee(null)).toBeNull();
  });

  it("os ids catalogados das quatro métricas", () => {
    expect(Object.values(SHOPEE_SALES_METRICS).map((m) => m.id)).toEqual([
      "shopee_pedidos",
      "shopee_unidades",
      "shopee_receita_bruta",
      "shopee_recebido",
    ]);
  });
});

describe("parseShopeeOrderItems", () => {
  it("lê o jsonb_agg da RPC", () => {
    expect(
      parseShopeeOrderItems([
        {
          item_id: 990000101,
          model_id: null,
          nome: "Capacete",
          variacao: null,
          quantidade: 2,
          sku_id: "5b1d0000-0000-4000-8000-0000000000aa",
          sku: "E2E-SKU-001",
          vinculo_via: "SKU_DO_ANUNCIO",
        },
      ]),
    ).toEqual([
      {
        itemId: 990000101,
        modelId: null,
        nome: "Capacete",
        variacao: null,
        quantidade: 2,
        skuId: "5b1d0000-0000-4000-8000-0000000000aa",
        sku: "E2E-SKU-001",
        vinculoVia: "SKU_DO_ANUNCIO",
      },
    ]);
  });

  it("pedido sem item (agregado nulo) é lista vazia; entrada estranha sai, campo estranho vira nulo", () => {
    expect(parseShopeeOrderItems(null)).toEqual([]);
    expect(parseShopeeOrderItems({ item_id: 1 })).toEqual([]);
    expect(parseShopeeOrderItems([1, "x", null, [], { item_id: "1", quantidade: "2", nome: "  " }])).toEqual([
      {
        itemId: null,
        modelId: null,
        nome: null,
        variacao: null,
        quantidade: null,
        skuId: null,
        sku: null,
        vinculoVia: null,
      },
    ]);
  });
});

describe("janela, loja", () => {
  it("a janela flexiona pelo total", () => {
    expect(summarizeShopeeOrdersWindow(1, 1, 1).label).toBe("1 pedido.");
    expect(summarizeShopeeOrdersWindow(1, 0, 0).label).toBe("Nenhum pedido no filtro atual.");
    expect(summarizeShopeeOrdersWindow(2, 120, 50)).toEqual({ label: "Mostrando 51 a 100 de 120 pedidos.", totalPages: 3 });
  });

  it("nome da loja, e loja de teste é tudo que não é live", () => {
    expect(nomeDaLojaShopee({ shop_name: "Loja X", shop_id: 1 })).toBe("Loja X");
    expect(nomeDaLojaShopee({ shop_name: null, shop_id: 990000001 })).toBe("Loja 990000001");
    expect(lojaDeTesteShopee("sandbox")).toBe(true);
    expect(lojaDeTesteShopee("live")).toBe(false);
  });
});
