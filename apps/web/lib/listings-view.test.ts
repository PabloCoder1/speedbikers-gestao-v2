import { describe, expect, it } from "vitest";

import {
  QUICK_VIEWS,
  buildListingsHref,
  isQuickViewActive,
  quickViewHref,
  recorteConversion,
  resolveListingsFilters,
  revenueShare,
} from "./listings-view";

const SLUGS = ["loja-1", "loja-2"];

describe("recorte de /anuncios lido da URL", () => {
  it("conta desconhecida vira todas as contas; o resto usa os resolvedores de sempre", () => {
    const filtros = resolveListingsFilters({ conta: "loja-9", estoque: "out", ordem: "units_desc" }, SLUGS);

    expect(filtros.account).toBeNull();
    expect(filtros.stock).toBe("out");
    expect(filtros.order).toEqual({ column: "units", direction: "desc" });
  });

  it("a URL gerada é lida de volta no mesmo recorte (tela e CSV não divergem)", () => {
    const filtros = resolveListingsFilters({ conta: "loja-2", venda: "with", dias: "7", busca: " bau " }, SLUGS);
    const href = buildListingsHref(filtros, {});
    const query = Object.fromEntries(new URL(href, "http://x").searchParams.entries());

    expect(resolveListingsFilters(query, SLUGS)).toEqual(filtros);
    expect(filtros.search).toBe("bau");
  });
});

describe("visões rápidas", () => {
  const base = resolveListingsFilters({ dias: "7", conta: "loja-1" }, SLUGS);
  const zerado = QUICK_VIEWS.find((v) => v.key === "zerado-vendendo");

  it("são combinações dos filtros de sempre — e mantêm conta e período", () => {
    const href = zerado === undefined ? "" : quickViewHref(zerado, base);

    expect(href).toContain("estoque=out");
    expect(href).toContain("venda=with");
    expect(href).toContain("dias=7");
    expect(href).toContain("conta=loja-1");
  });

  it("ativa só com os eixos de estado exatamente iguais, e clicar de novo desfaz", () => {
    const naVisao = resolveListingsFilters({ estoque: "out", venda: "with", dias: "7", conta: "loja-1" }, SLUGS);
    const comMais = resolveListingsFilters({ estoque: "out", venda: "with", estado: "active" }, SLUGS);

    expect(zerado !== undefined && isQuickViewActive(zerado, naVisao)).toBe(true);
    expect(zerado !== undefined && isQuickViewActive(zerado, comMais)).toBe(false);

    const desfaz = zerado === undefined ? "" : quickViewHref(zerado, naVisao);

    expect(desfaz).not.toContain("estoque=");
    expect(desfaz).toContain("dias=7");
  });
});

describe("resumo do recorte", () => {
  it("conversão é pedidos ÷ visitas somados, e indefinida sem visita", () => {
    expect(recorteConversion(50, 1000)).toBe(0.05);
    expect(recorteConversion(3, 0)).toBeNull();
    expect(recorteConversion(3, null)).toBeNull();
    expect(recorteConversion(undefined, 10)).toBeNull();
  });

  it("participação no faturamento fica entre 0 e 1, e é indefinida sem faturamento", () => {
    expect(revenueShare(250, 1000)).toBe(0.25);
    expect(revenueShare(10, 0)).toBeNull();
    expect(revenueShare(10, undefined)).toBeNull();
  });
});
