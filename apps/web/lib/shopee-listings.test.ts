import { describe, expect, it } from "vitest";

import {
  SHOPEE_LINK_STATES,
  SHOPEE_PAGE_SIZE,
  buildShopeeKpiHref,
  buildShopeeListingsHref,
  explicacaoDoAguardando,
  formatShopeeMoney,
  isShopeeSchemaMissing,
  resolveShopeeListingsFilters,
  resumoDoCatalogoShopee,
  shopeeImageUrl,
  shopeeItemStatus,
  shopeeLinkState,
  shopeeModelUnavailable,
  summarizeShopeeWindow,
} from "./shopee-listings";

const LOJA = "5b1d0000-0000-4000-8000-000000000001";

describe("resolveShopeeListingsFilters", () => {
  it("URL vazia é 'sem filtro', página 1", () => {
    expect(resolveShopeeListingsFilters({}, [LOJA])).toEqual({ loja: null, estado: null, busca: null, pagina: 1 });
  });

  it("aceita só loja da organização e estado do conjunto fechado", () => {
    expect(resolveShopeeListingsFilters({ loja: LOJA, estado: "sem-sku" }, [LOJA])).toMatchObject({
      loja: LOJA,
      estado: "sem-sku",
    });
    expect(
      resolveShopeeListingsFilters({ loja: "5b1d0000-0000-4000-8000-000000000999", estado: "VINCULADO" }, [LOJA]),
    ).toMatchObject({ loja: null, estado: null });
  });

  it("busca aparada; vazia é sem busca; página inválida cai em 1", () => {
    expect(resolveShopeeListingsFilters({ q: "  luva  ", pagina: "3" }, [])).toMatchObject({ busca: "luva", pagina: 3 });
    expect(resolveShopeeListingsFilters({ q: "   ", pagina: "-2" }, [])).toMatchObject({ busca: null, pagina: 1 });
    expect(resolveShopeeListingsFilters({ q: ["a", "b"] }, [])).toMatchObject({ busca: "a" });
  });

  it("página absurda na URL é presa: o offset nunca estoura o integer do banco", () => {
    const { pagina } = resolveShopeeListingsFilters({ pagina: "99999999999" }, []);

    expect((pagina - 1) * SHOPEE_PAGE_SIZE).toBeLessThanOrEqual(2_147_483_647);
    expect(pagina).toBeGreaterThan(1);
  });
});

describe("buildShopeeListingsHref", () => {
  const filtros = { loja: LOJA, estado: "vinculado", busca: "luva", pagina: 3 } as const;

  it("a paginação preserva os filtros", () => {
    expect(buildShopeeListingsHref(filtros, { pagina: 4 })).toBe(
      `/anuncios/shopee?loja=${LOJA}&estado=vinculado&q=luva&pagina=4`,
    );
  });

  it("trocar um filtro volta à página 1 e mantém os outros", () => {
    expect(buildShopeeListingsHref(filtros, { estado: "sem-sku" })).toBe(
      `/anuncios/shopee?loja=${LOJA}&estado=sem-sku&q=luva`,
    );
    expect(buildShopeeListingsHref({ loja: null, estado: null, busca: null, pagina: 1 })).toBe("/anuncios/shopee");
  });

  it("o 'ver lista' da faixa fica no escopo dela: mantém a loja, larga a busca e a página", () => {
    expect(buildShopeeKpiHref(filtros, "sem-sku")).toBe(`/anuncios/shopee?loja=${LOJA}&estado=sem-sku`);
    expect(buildShopeeKpiHref(filtros, null)).toBe(`/anuncios/shopee?loja=${LOJA}`);
  });
});

describe("estados do vínculo", () => {
  it("os quatro estados da view, cada um com rótulo próprio", () => {
    expect(SHOPEE_LINK_STATES.map((e) => e.codigo)).toEqual([
      "VINCULADO",
      "SEM_SKU_NO_ANUNCIO",
      "SKU_FORA_DO_CATALOGO",
      "AGUARDANDO_LEITURA",
    ]);
    // D-429: "Vinculados" conta o manual e o pelo SKU do anúncio, e diz isso.
    expect(shopeeLinkState("VINCULADO")?.rotulo).toBe("Vinculados");
    expect(shopeeLinkState("VINCULADO")?.explicacao).toBe("manual ou pelo SKU do anúncio");
    expect(shopeeLinkState("VINCULADO")?.criterio).toMatch(/vínculo manual/);
    expect(shopeeLinkState("OUTRO")).toBeNull();
  });
});

describe("shopeeItemStatus", () => {
  it("traduz os quatro estados de um anúncio vivo, e mostra cru o desconhecido", () => {
    expect(shopeeItemStatus("NORMAL").rotulo).toBe("Ativo");
    expect(shopeeItemStatus("UNLIST").rotulo).toBe("Pausado");
    expect(shopeeItemStatus("BANNED").rotulo).toBe("Banido");
    expect(shopeeItemStatus("REVIEWING").rotulo).toBe("Em revisão");
    expect(shopeeItemStatus("NOVO_ESTADO")).toEqual({ rotulo: "NOVO_ESTADO", tom: "neutro" });
  });

  it("variação indisponível é só MODEL_UNAVAILABLE", () => {
    expect(shopeeModelUnavailable("MODEL_UNAVAILABLE")).toBe(true);
    expect(shopeeModelUnavailable("MODEL_NORMAL")).toBe(false);
    expect(shopeeModelUnavailable(null)).toBe(false);
  });
});

describe("formatShopeeMoney", () => {
  it("ausente é '—', nunca zero", () => {
    expect(formatShopeeMoney(null, "BRL")).toBe("—");
  });

  it("usa a moeda da linha", () => {
    expect(formatShopeeMoney(249.9, "BRL").replace(/\s/g, " ")).toBe("R$ 249,90");
    expect(formatShopeeMoney(10, "brl").replace(/\s/g, " ")).toBe("R$ 10,00");
  });

  it("sem moeda, ou moeda que o Intl não conhece, não supõe real", () => {
    expect(formatShopeeMoney(12.5, null)).toBe("12,50");
    expect(formatShopeeMoney(12.5, "não-é-moeda")).toBe("NÃO-É-MOEDA 12,50");
  });
});

describe("shopeeImageUrl", () => {
  it("só os hosts que a CSP abre, e só em https", () => {
    expect(shopeeImageUrl("https://down-br.img.susercontent.com/file/abc")).toBe(
      "https://down-br.img.susercontent.com/file/abc",
    );
    expect(shopeeImageUrl("https://cf.shopee.com.br/file/abc")).toBe("https://cf.shopee.com.br/file/abc");
    expect(shopeeImageUrl("http://cf.shopee.com.br/file/abc")).toBeNull();
    expect(shopeeImageUrl("https://exemplo.com/file/abc")).toBeNull();
    expect(shopeeImageUrl("https://susercontent.com.exemplo.com/x")).toBeNull();
    expect(shopeeImageUrl("não é url")).toBeNull();
    expect(shopeeImageUrl(null)).toBeNull();
  });
});

describe("isShopeeSchemaMissing", () => {
  it("tabela, coluna ou função ausente; erro comum não", () => {
    for (const code of ["PGRST205", "42P01", "PGRST202", "42883", "42703"]) {
      expect(isShopeeSchemaMissing({ code })).toBe(true);
    }

    expect(isShopeeSchemaMissing({ code: "57014" })).toBe(false);
    expect(isShopeeSchemaMissing(null)).toBe(false);
  });
});

describe("summarizeShopeeWindow", () => {
  it("flexiona pelo total e declara a janela quando há mais de uma página", () => {
    expect(summarizeShopeeWindow(1, 1, 1).label).toBe("1 anúncio.");
    expect(summarizeShopeeWindow(2, 120, 50)).toEqual({ label: "Mostrando 51 a 100 de 120 anúncios.", totalPages: 3 });
  });
});

describe("explicacaoDoAguardando (D-428)", () => {
  it("nunca lido, lido sem variações e leitura que não serviu têm explicações distintas", () => {
    expect(explicacaoDoAguardando(null, null)).toBe("o detalhe ainda não foi lido");
    expect(explicacaoDoAguardando(null, "2026-10-13T15:00:00Z")).toBe("as variações ainda não foram lidas");
    expect(explicacaoDoAguardando("nao_devolvido", "2026-10-13T15:00:00Z")).toMatch(/nova tentativa em até 1 dia/);
  });
});


describe("resumoDoCatalogoShopee (D-429)", () => {
  it("flexiona cada número; catálogo nunca lido é nulo, nunca zero", () => {
    expect(resumoDoCatalogoShopee(5, 2)).toBe("5 anúncios · 2 vinculados");
    expect(resumoDoCatalogoShopee(1, 1)).toBe("1 anúncio · 1 vinculado");
    expect(resumoDoCatalogoShopee(0, 0)).toBe("0 anúncios · 0 vinculados");
    expect(resumoDoCatalogoShopee(null, null)).toBeNull();
  });
});
