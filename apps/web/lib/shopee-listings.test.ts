import { describe, expect, it } from "vitest";

import {
  SHOPEE_LINK_STATES,
  SHOPEE_PAGE_SIZE,
  buildShopeeKpiHref,
  buildShopeeListingsHref,
  explicacaoDoAguardando,
  formatShopeeMoney,
  isShopeeSchemaMissing,
  argumentosDeVendasShopee,
  proximaOrdemShopee,
  recorteDeVendasShopee,
  resolveShopeeListingsFilters,
  resumoDoCatalogoShopee,
  shopeeImageUrl,
  shopeeItemStatus,
  shopeeLinkState,
  shopeeModelUnavailable,
  summarizeShopeeWindow,
} from "./shopee-listings";

const LOJA = "5b1d0000-0000-4000-8000-000000000001";
const HOJE = "2026-10-19";

/** O período padrão (30 dias até hoje), sem venda nem ordem: o que a URL vazia resolve. */
const PADRAO = {
  range: { from: "2026-09-20", to: HOJE },
  days: 30,
  periodoInvalido: false,
  vendeu: null,
  ordem: null,
} as const;

describe("resolveShopeeListingsFilters", () => {
  it("URL vazia é 'sem filtro', página 1", () => {
    expect(resolveShopeeListingsFilters({}, [LOJA], HOJE)).toEqual({ loja: null, estado: null, busca: null, pagina: 1, ...PADRAO });
  });

  it("aceita só loja da organização e estado do conjunto fechado", () => {
    expect(resolveShopeeListingsFilters({ loja: LOJA, estado: "sem-sku" }, [LOJA], HOJE)).toMatchObject({
      loja: LOJA,
      estado: "sem-sku",
    });
    expect(
      resolveShopeeListingsFilters({ loja: "5b1d0000-0000-4000-8000-000000000999", estado: "VINCULADO" }, [LOJA], HOJE),
    ).toMatchObject({ loja: null, estado: null });
  });

  it("busca aparada; vazia é sem busca; página inválida cai em 1", () => {
    expect(resolveShopeeListingsFilters({ q: "  luva  ", pagina: "3" }, [], HOJE)).toMatchObject({ busca: "luva", pagina: 3 });
    expect(resolveShopeeListingsFilters({ q: "   ", pagina: "-2" }, [], HOJE)).toMatchObject({ busca: null, pagina: 1 });
    expect(resolveShopeeListingsFilters({ q: ["a", "b"] }, [], HOJE)).toMatchObject({ busca: "a" });
  });

  it("página absurda na URL é presa: o offset nunca estoura o integer do banco", () => {
    const { pagina } = resolveShopeeListingsFilters({ pagina: "99999999999" }, [], HOJE);

    expect((pagina - 1) * SHOPEE_PAGE_SIZE).toBeLessThanOrEqual(2_147_483_647);
    expect(pagina).toBeGreaterThan(1);
  });
});

describe("buildShopeeListingsHref", () => {
  const filtros = { loja: LOJA, estado: "vinculado", busca: "luva", pagina: 3, ...PADRAO } as const;

  it("a paginação preserva os filtros", () => {
    expect(buildShopeeListingsHref(filtros, { pagina: 4 })).toBe(
      `/anuncios/shopee?loja=${LOJA}&estado=vinculado&q=luva&pagina=4`,
    );
  });

  it("trocar um filtro volta à página 1 e mantém os outros", () => {
    expect(buildShopeeListingsHref(filtros, { estado: "sem-sku" })).toBe(
      `/anuncios/shopee?loja=${LOJA}&estado=sem-sku&q=luva`,
    );
    expect(buildShopeeListingsHref({ loja: null, estado: null, busca: null, pagina: 1, ...PADRAO })).toBe("/anuncios/shopee");
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

describe("as vendas por anúncio: período, vendeu e ordem (D-606)", () => {
  it("o período é o de `/anuncios`: preset, personalizado e o inválido que cai no padrão e avisa", () => {
    expect(resolveShopeeListingsFilters({ days: "7" }, [], HOJE)).toMatchObject({ days: 7, range: { from: "2026-10-13", to: HOJE } });
    expect(resolveShopeeListingsFilters({ from: "2026-10-01", to: "2026-10-10" }, [], HOJE)).toMatchObject({
      days: null,
      range: { from: "2026-10-01", to: "2026-10-10" },
      periodoInvalido: false,
    });
    expect(resolveShopeeListingsFilters({ from: "2026-10-10", to: "2026-10-01" }, [], HOJE)).toMatchObject({ days: 30, periodoInvalido: true });
  });

  it("vendeu e ordem só do conjunto fechado; fora dele, nada", () => {
    expect(resolveShopeeListingsFilters({ vendeu: "sem", ordem: "receita" }, [], HOJE)).toMatchObject({ vendeu: "sem", ordem: "receita" });
    expect(resolveShopeeListingsFilters({ vendeu: "talvez", ordem: "preco" }, [], HOJE)).toMatchObject({ vendeu: null, ordem: null });
  });

  it("o endereço leva o período fora do padrão, o vendeu e a ordem; trocar volta à página 1", () => {
    const filtros = resolveShopeeListingsFilters({ loja: LOJA, days: "7", vendeu: "com", ordem: "vendas", pagina: "2" }, [LOJA], HOJE);

    expect(buildShopeeListingsHref(filtros, { pagina: 3 })).toBe(`/anuncios/shopee?loja=${LOJA}&days=7&vendeu=com&ordem=vendas&pagina=3`);
    expect(buildShopeeListingsHref(filtros, { vendeu: null })).toBe(`/anuncios/shopee?loja=${LOJA}&days=7&ordem=vendas`);
    expect(buildShopeeListingsHref({ ...filtros, days: null, range: { from: "2026-10-01", to: "2026-10-10" } }, {})).toBe(
      `/anuncios/shopee?loja=${LOJA}&from=2026-10-01&to=2026-10-10&vendeu=com&ordem=vendas`,
    );
  });

  it("os argumentos do C-67: o período sempre, o filtro e a ordem só com valor (PGRST202)", () => {
    const padrao = resolveShopeeListingsFilters({}, [], HOJE);

    expect(argumentosDeVendasShopee(padrao)).toEqual({ p_date_from: "2026-09-20", p_date_to: HOJE });
    expect(argumentosDeVendasShopee({ ...padrao, vendeu: "sem", ordem: "receita" })).toEqual({
      p_date_from: "2026-09-20",
      p_date_to: HOJE,
      p_vendeu: "sem",
      p_ordem: "receita",
    });
  });
});

describe("o cabeçalho que ordena e o resumo do recorte (D-606)", () => {
  it("a coluna ordena do maior para o menor; clicar de novo volta à ordem de sempre", () => {
    expect(proximaOrdemShopee(null, "vendas")).toBe("vendas");
    expect(proximaOrdemShopee("receita", "vendas")).toBe("vendas");
    expect(proximaOrdemShopee("vendas", "vendas")).toBeNull();
  });

  it("o recorte vem do SQL; sem a coluna ou sem loja lida, não há resumo -- nunca zero", () => {
    expect(recorteDeVendasShopee({ recorte_unidades: 11, recorte_receita: 1100, recorte_unidades_sem_receita: 0 })).toEqual({
      unidades: 11,
      receita: 1100,
      semReceita: 0,
    });
    expect(recorteDeVendasShopee({ recorte_unidades: 3, recorte_receita: null, recorte_unidades_sem_receita: 3 })).toEqual({
      unidades: 3,
      receita: null,
      semReceita: 3,
    });
    expect(recorteDeVendasShopee({ recorte_unidades: null, recorte_receita: null })).toBeNull();
    expect(recorteDeVendasShopee({})).toBeNull();
    expect(recorteDeVendasShopee(undefined)).toBeNull();
  });
});
