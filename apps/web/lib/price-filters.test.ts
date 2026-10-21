import { describe, expect, it } from "vitest";

import {
  argumentosDoMarketplace,
  buildPriceExportHref,
  buildPriceHref,
  priceDirectionLabel,
  resolvePriceFilters,
  resolvePriceWindow,
  type PriceFilters,
} from "./price-filters";

/** O recorte limpo, base dos casos de janela e de href de exportação. */
const VAZIO: PriceFilters = {
  marketplace: "ml",
  search: null,
  direction: null,
  account: null,
  loja: null,
  dateFrom: null,
  dateTo: null,
  page: 1,
};

describe("resolvePriceFilters", () => {
  it("URL vazia é 'sem filtro', página 1", () => {
    expect(resolvePriceFilters({})).toEqual({
      marketplace: "ml",
      search: null,
      direction: null,
      account: null,
      loja: null,
      dateFrom: null,
      dateTo: null,
      page: 1,
    });
  });

  it("direção fora do conjunto fechado cai para sem filtro, não vira erro", () => {
    expect(resolvePriceFilters({ direcao: "lateral" }).direction).toBeNull();
    expect(resolvePriceFilters({ direcao: "up" }).direction).toBe("up");
    expect(resolvePriceFilters({ direcao: "down" }).direction).toBe("down");
  });

  it("data só passa no formato do dia civil", () => {
    expect(resolvePriceFilters({ de: "2026-08-24" }).dateFrom).toBe("2026-08-24");
    expect(resolvePriceFilters({ de: "24/08/2026" }).dateFrom).toBeNull();
    expect(resolvePriceFilters({ ate: "ontem" }).dateTo).toBeNull();
  });

  it("busca em branco é ausência de busca, não busca por espaço", () => {
    expect(resolvePriceFilters({ busca: "   " }).search).toBeNull();
    expect(resolvePriceFilters({ busca: " MLB123 " }).search).toBe("MLB123");
  });

  it("página inválida volta para 1", () => {
    expect(resolvePriceFilters({ pagina: "0" }).page).toBe(1);
    expect(resolvePriceFilters({ pagina: "-3" }).page).toBe(1);
    expect(resolvePriceFilters({ pagina: "abc" }).page).toBe(1);
    expect(resolvePriceFilters({ pagina: "7" }).page).toBe(7);
  });
});

describe("buildPriceHref", () => {
  const base = resolvePriceFilters({ busca: "guidao", direcao: "down", pagina: "4" });

  it("trocar de dimensão preserva as outras e volta à página 1", () => {
    expect(buildPriceHref(base, { direction: "up" })).toBe("/precos?busca=guidao&direcao=up");
  });

  it("mudar de página preserva os filtros", () => {
    expect(buildPriceHref(base, { page: 2 })).toBe("/precos?busca=guidao&direcao=down&pagina=2");
  });

  it("limpar uma dimensão a remove da URL", () => {
    expect(buildPriceHref(base, { direction: null })).toBe("/precos?busca=guidao");
  });
});

describe("priceDirectionLabel", () => {
  it("traduz o conjunto conhecido", () => {
    expect(priceDirectionLabel("up")).toBe("Aumentos");
    expect(priceDirectionLabel("down")).toBe("Reduções");
  });

  it("é total: valor desconhecido degrada para o próprio valor", () => {
    expect(priceDirectionLabel("sideways")).toBe("sideways");
  });
});

/**
 * A janela da consulta (D-292) — extraída de `page.tsx` porque a exportação
 * precisa da MESMA conta. Duas cópias produziriam uma planilha de um período e
 * uma tela de outro, com o mesmo link.
 */
describe("resolvePriceWindow", () => {
  const AGORA = new Date("2026-09-09T15:00:00Z");

  it("sem filtro de data, a janela é dos últimos 30 dias, contando hoje", () => {
    const janela = resolvePriceWindow({ ...VAZIO }, AGORA);

    expect(janela.dayFrom).toBe("2026-08-11");
    expect(janela.from).toBe("2026-08-11T00:00:00Z");
    expect(janela.dayTo).toBeNull();
  });

  /*
    A regra que o comentário da página dizia e nenhum teste segurava: o usuário
    filtra por DIA, o evento tem HORA, e `ate` é inclusivo na tela. Sem o dia
    seguinte no limite, toda alteração do último dia escolhido sumiria do
    recorte — e ninguém veria, porque a tabela continuaria plausível.
  */
  it("`ate` é inclusivo na tela e vira o INÍCIO do dia seguinte na consulta", () => {
    const janela = resolvePriceWindow({ ...VAZIO, dateFrom: "2026-09-01", dateTo: "2026-09-09" }, AGORA);

    expect(janela.from).toBe("2026-09-01T00:00:00Z");
    expect(janela.to).toBe("2026-09-10T00:00:00.000Z");
    expect(janela.dayTo).toBe("2026-09-09");
  });

  it("sem `ate`, o limite superior é amanhã — o que hoje ainda vai acontecer entra", () => {
    const janela = resolvePriceWindow({ ...VAZIO, dateFrom: "2026-09-01" }, AGORA);

    expect(janela.to).toBe("2026-09-10T15:00:00.000Z");
  });
});

describe("buildPriceExportHref", () => {
  it("leva o recorte e NÃO leva a página — a planilha é o recorte inteiro", () => {
    const href = buildPriceExportHref({
      ...VAZIO,
      search: "guidao",
      direction: "down",
      account: null,
      dateFrom: "2026-09-01",
      dateTo: null,
      page: 7,
    });

    expect(href).toBe("/precos/export/xlsx?busca=guidao&direcao=down&de=2026-09-01");
    expect(href).not.toContain("pagina");
  });
});

/** D-640 (C-81): o recorte de marketplace e a loja da Shopee. */
describe("o marketplace e a loja na /precos (D-640)", () => {
  it("sem marketplace, ou com valor desconhecido, é o Mercado Livre de sempre", () => {
    expect(resolvePriceFilters({}).marketplace).toBe("ml");
    expect(resolvePriceFilters({ marketplace: "tiktok" }).marketplace).toBe("ml");
    expect(resolvePriceFilters({ marketplace: "shopee" }).marketplace).toBe("shopee");
    expect(resolvePriceFilters({ marketplace: "todos" }).marketplace).toBe("todos");
  });

  it("a conta só vale no ML e a loja só na Shopee — a RPC recusa a mistura", () => {
    expect(resolvePriceFilters({ conta: "c1", loja: "l1" })).toMatchObject({ account: "c1", loja: null });
    expect(resolvePriceFilters({ marketplace: "shopee", conta: "c1", loja: "l1" })).toMatchObject({ account: null, loja: "l1" });
    expect(resolvePriceFilters({ marketplace: "todos", conta: "c1", loja: "l1" })).toMatchObject({ account: null, loja: null });
  });

  it("a URL leva o marketplace e a loja, e o ML continua sem o parâmetro", () => {
    const shopee = resolvePriceFilters({ marketplace: "shopee", loja: "l1", busca: "capacete" });

    expect(buildPriceHref(shopee, { page: 2 })).toBe("/precos?marketplace=shopee&busca=capacete&loja=l1&pagina=2");
    expect(buildPriceHref(shopee, { marketplace: "ml", loja: null })).toBe("/precos?busca=capacete");
    expect(buildPriceExportHref(shopee)).toBe("/precos/export/xlsx?marketplace=shopee&busca=capacete&loja=l1");
  });

  it("os argumentos da RPC só com valor: o ML manda só o de sempre, sem parâmetro novo", () => {
    expect(argumentosDoMarketplace(VAZIO, "c1", null)).toEqual({ p_ml_account_id: "c1" });
    expect(argumentosDoMarketplace(VAZIO, null, null)).toEqual({ p_ml_account_id: null });
    expect(argumentosDoMarketplace({ ...VAZIO, marketplace: "shopee" }, null, null)).toEqual({ p_marketplace: "shopee" });
    expect(argumentosDoMarketplace({ ...VAZIO, marketplace: "shopee" }, null, "l1")).toEqual({
      p_marketplace: "shopee",
      p_shopee_shop_id: "l1",
    });
    expect(argumentosDoMarketplace({ ...VAZIO, marketplace: "todos" }, null, null)).toEqual({ p_marketplace: "todos" });
  });
});
