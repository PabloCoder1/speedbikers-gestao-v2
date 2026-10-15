import { describe, expect, it } from "vitest";

import {
  diasDasBarras,
  diasForaDaRazao,
  estadoAdsLoja,
  lojaAdsDeTeste,
  separarAdsShopee,
  type DiaAdsShopee,
  type LinhaAdsShopee,
} from "./ads-shopee";

/** Uma linha de `get_shopee_ads_overview` com os números do teste de integração de D-449. */
function linha(sobre: Partial<LinhaAdsShopee>): LinhaAdsShopee {
  return {
    nivel: "CONTA",
    account_id: "5bf2ce24-4c02-4c8b-a1d7-a7973bbc96c4",
    account_name: "Speed Bikers Oficial",
    environment: "live",
    cobertura_completa: true,
    dias_lidos: 7,
    // D-455: os dias lidos sem gasto ou sem venda (fora do ROAS e do ACOS).
    dias_sem_gasto: 0,
    dias_sem_venda: 0,
    investimento: 15,
    receita_ads: 100,
    receita_ads_direta: 60,
    pedidos_ads: 3,
    cliques: 40,
    impressoes: 900,
    roas: 6.6667,
    acos: 0.15,
    receita_bruta: 200,
    tacos: 0.075,
    ultima_atualizacao: "2026-10-14T20:00:00+00:00",
    ...sobre,
  };
}

/** Ads nunca lidos: o banco devolve tudo nulo (D-449). */
const NUNCA_LIDA = linha({
  account_name: "Loja de teste",
  environment: "sandbox",
  cobertura_completa: null,
  dias_lidos: null,
  investimento: null,
  receita_ads: null,
  receita_ads_direta: null,
  pedidos_ads: null,
  cliques: null,
  impressoes: null,
  roas: null,
  acos: null,
  receita_bruta: null,
  tacos: null,
  ultima_atualizacao: null,
});

describe("separarAdsShopee (D-456)", () => {
  it("separa o TOTAL das lojas, sem somar nada", () => {
    const total = linha({ nivel: "TOTAL", account_id: null, account_name: null, environment: null });
    const ads = separarAdsShopee([total, linha({}), NUNCA_LIDA]);

    expect(ads.total).toBe(total);
    expect(ads.lojas).toHaveLength(2);
  });

  it("sem loja real com Ads lidos, não há TOTAL — e isso não vira um total de zeros", () => {
    const ads = separarAdsShopee([NUNCA_LIDA]);

    expect(ads.total).toBeNull();
    expect(ads.lojas).toEqual([NUNCA_LIDA]);
  });

  it("leitura vazia ou nula: nada", () => {
    expect(separarAdsShopee(null)).toEqual({ total: null, lojas: [] });
    expect(separarAdsShopee([])).toEqual({ total: null, lojas: [] });
  });
});

describe("o estado de cada loja (D-456)", () => {
  it("Ads nunca lidos é 'não lido', não 'sem anúncio'", () => {
    expect(estadoAdsLoja(NUNCA_LIDA)).toBe("nao_lido");
  });

  it("lida e com zero é 'sem anúncio no período'", () => {
    expect(
      estadoAdsLoja(linha({ investimento: 0, receita_ads: 0, cliques: 0, roas: null, acos: null, tacos: 0 })),
    ).toBe("sem_anuncio");
  });

  it("com investimento, venda ou clique é 'com anúncio'", () => {
    expect(estadoAdsLoja(linha({}))).toBe("com_anuncio");
    expect(estadoAdsLoja(linha({ investimento: 0, receita_ads: 12 }))).toBe("com_anuncio");
    expect(estadoAdsLoja(linha({ investimento: 0, receita_ads: 0, cliques: 5 }))).toBe("com_anuncio");
  });

  it("a loja de teste é marcada; a real e o TOTAL (sem ambiente) não", () => {
    expect(lojaAdsDeTeste(NUNCA_LIDA)).toBe(true);
    expect(lojaAdsDeTeste(linha({}))).toBe(false);
    expect(lojaAdsDeTeste(linha({ nivel: "TOTAL", environment: null }))).toBe(false);
  });
});

describe("diasForaDaRazao (D-455, D-466)", () => {
  it("o dia sem o gasto ou sem as vendas fica fora do ROAS e do ACOS, e a tela diz quantos", () => {
    expect(diasForaDaRazao({ dias_sem_gasto: 2, dias_sem_venda: 1 })).toBe("fora da razão: 2 dias sem o gasto e 1 dia sem as vendas");
    expect(diasForaDaRazao({ dias_sem_gasto: 0, dias_sem_venda: 3 })).toBe("fora da razão: 3 dias sem as vendas");
  });

  it("todos os dias com os dois, loja nunca lida (nulo) ou a função de antes da migration: nada a dizer", () => {
    expect(diasForaDaRazao({ dias_sem_gasto: 0, dias_sem_venda: 0 })).toBeNull();
    expect(diasForaDaRazao({ dias_sem_gasto: null, dias_sem_venda: null })).toBeNull();
    // Chave ausente: a resposta antiga não traz as colunas.
    expect(diasForaDaRazao({} as { dias_sem_gasto: number | null; dias_sem_venda: number | null })).toBeNull();
  });
});

describe("diasDasBarras (D-456)", () => {
  const dia = (d: string, investimento: number | null, receita: number | null): DiaAdsShopee => ({
    dia: d,
    investimento,
    receita_ads: receita,
    receita_ads_direta: null,
    pedidos_ads: null,
    cliques: null,
    impressoes: null,
    roas: null,
    acos: null,
  });

  it("dia sem o valor da Shopee não vira barra de zero: fica de fora e é contado pelo campo que faltou", () => {
    const r = diasDasBarras([
      dia("2026-10-11", 7, null),
      dia("2026-10-12", 5, 30),
      dia("2026-10-13", null, 10),
      dia("2026-10-14", 0, 0),
    ]);

    expect(r.barras).toEqual([
      { dia: "2026-10-12", investimento: 5, receita_ads: 30 },
      { dia: "2026-10-14", investimento: 0, receita_ads: 0 },
    ]);
    expect(r.semGasto).toBe(1);
    expect(r.semVenda).toBe(1);
  });

  it("série nula (erro de leitura) não inventa dias", () => {
    expect(diasDasBarras(null)).toEqual({ barras: [], semGasto: 0, semVenda: 0 });
  });
});
