import { describe, expect, it } from "vitest";

import {
  MARKETPLACE_ROTULO,
  buscaCompativel,
  hrefDosAnuncios,
  marketplacesVisiveis,
  opcoesDeMarketplace,
} from "./marketplace";

const DESTINOS = { ml: "/vendas?days=7", shopee: "/vendas/shopee?days=7" } as const;

describe("marketplacesVisiveis", () => {
  it("oferece os dois quando há conta do ML e loja Shopee, na ordem fixa", () => {
    expect(marketplacesVisiveis({ ml: 4, shopee: 1 }, "ml")).toEqual(["ml", "shopee"]);
    expect(marketplacesVisiveis({ ml: 4, shopee: 1 }, "shopee")).toEqual(["ml", "shopee"]);
  });

  it("quem só tem Mercado Livre fica só com ele — a tela não ganha seletor", () => {
    expect(marketplacesVisiveis({ ml: 4, shopee: 0 }, "ml")).toEqual(["ml"]);
  });

  it("o ativo sempre entra, mesmo sem conta: a pessoa já está nele", () => {
    expect(marketplacesVisiveis({ ml: 3, shopee: 0 }, "shopee")).toEqual(["ml", "shopee"]);
    expect(marketplacesVisiveis({ ml: 0, shopee: 0 }, "shopee")).toEqual(["shopee"]);
  });

  it("leitura que falhou não vira opção — nunca levar a uma tela que não se confirmou", () => {
    expect(marketplacesVisiveis({ ml: 4, shopee: null }, "ml")).toEqual(["ml"]);
    expect(marketplacesVisiveis({ ml: null, shopee: 2 }, "shopee")).toEqual(["shopee"]);
  });
});

describe("opcoesDeMarketplace", () => {
  it("com um marketplace só, não há menu", () => {
    expect(opcoesDeMarketplace("ml", ["ml"], DESTINOS)).toBeNull();
  });

  it("cada opção leva ao destino da tela, com o rótulo do marketplace e o ativo marcado", () => {
    expect(opcoesDeMarketplace("shopee", ["ml", "shopee"], DESTINOS)).toEqual([
      { href: "/vendas?days=7", ativo: false, label: "Mercado Livre" },
      { href: "/vendas/shopee?days=7", ativo: true, label: "Shopee" },
    ]);
  });

  it("com o destino do consolidado (D-440), 'Todos os marketplaces' vem primeiro — e só com dois canais", () => {
    const comTodos = { ...DESTINOS, todos: "/vendas?marketplace=todos&days=7" };

    expect(opcoesDeMarketplace("todos", ["ml", "shopee"], comTodos)).toEqual([
      { href: "/vendas?marketplace=todos&days=7", ativo: true, label: "Todos os marketplaces" },
      { href: "/vendas?days=7", ativo: false, label: "Mercado Livre" },
      { href: "/vendas/shopee?days=7", ativo: false, label: "Shopee" },
    ]);
    expect(opcoesDeMarketplace("ml", ["ml"], comTodos)).toBeNull();
    // Com o "todos" ativo, nenhum marketplace é forçado a aparecer.
    expect(marketplacesVisiveis({ ml: 4, shopee: 0 }, "todos")).toEqual(["ml"]);
  });

  it("o rótulo é por código, sem marca nenhuma fora do vocabulário", () => {
    expect(MARKETPLACE_ROTULO).toEqual({ ml: "Mercado Livre", shopee: "Shopee" });
  });
});

describe("buscaCompativel", () => {
  it("SKU e nome atravessam nos dois sentidos, sem espaço em volta", () => {
    expect(buscaCompativel("  KIT-PEDAL-01 ", "shopee")).toBe("KIT-PEDAL-01");
    expect(buscaCompativel("pedal de clip", "ml")).toBe("pedal de clip");
  });

  it("o código de anúncio do Mercado Livre não vai para a Shopee", () => {
    expect(buscaCompativel("MLB1476804187", "shopee")).toBeNull();
    expect(buscaCompativel("mlb-1476804187", "shopee")).toBeNull();
    // Um SKU que só começa com MLB não é código de anúncio.
    expect(buscaCompativel("MLB-KIT", "shopee")).toBe("MLB-KIT");
  });

  it("na volta, um número passa: pode ser o item da Shopee, mas também um SKU", () => {
    expect(buscaCompativel("27493040612", "ml")).toBe("27493040612");
  });

  it("busca vazia não vira parâmetro", () => {
    expect(buscaCompativel(null, "shopee")).toBeNull();
    expect(buscaCompativel("   ", "ml")).toBeNull();
  });
});

describe("hrefDosAnuncios", () => {
  it("cada lista com o seu nome de parâmetro", () => {
    expect(hrefDosAnuncios("shopee", "KIT-PEDAL-01")).toBe("/anuncios/shopee?q=KIT-PEDAL-01");
    expect(hrefDosAnuncios("ml", "KIT-PEDAL-01")).toBe("/anuncios?busca=KIT-PEDAL-01");
  });

  it("sem busca compatível, a lista limpa", () => {
    expect(hrefDosAnuncios("shopee", "MLB1476804187")).toBe("/anuncios/shopee");
    expect(hrefDosAnuncios("ml", null)).toBe("/anuncios");
  });
});
