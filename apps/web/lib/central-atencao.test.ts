import { describe, expect, it } from "vitest";

import { contarPorSeveridade, montarAtencao, rotuloDaContagem, type EntradaDaAtencao } from "./central-atencao";
import type { Indicador } from "./central-indicadores";
import type { MetaDoMes } from "./central-meta";
import { lerDetectorFrete, type DetectorDeFrete } from "./detector-frete";
import type { ProdutosDoFaturamento } from "./faturamento";
import { lerSinaisAds, type SinaisAds } from "./sinais-ads";

function limpo(texto: string): string {
  return texto.replaceAll(String.fromCharCode(160), " ");
}

function sinaisAds(contagens: { critico: number; abaixo_meta: number; atencao: number; escala: number }): SinaisAds {
  const lido = lerSinaisAds({
    janela: {
      inicio: "2026-09-14",
      fim: "2026-09-20",
      anterior_inicio: "2026-09-07",
      anterior_fim: "2026-09-13",
      dias_pendentes: [],
    },
    referencias: { ctr_mediano: null, conversao_mediana: null },
    resumo: {
      campanhas: 20,
      ...contagens,
      normal: 0,
      pausada: 0,
      investimento: 0,
      receita_ads: 0,
      roas: null,
      investimento_anterior: 0,
      receita_ads_anterior: 0,
      roas_anterior: null,
    },
    campanhas: [],
  });

  if (lido === null) throw new Error("fixture de Ads fora do contrato");

  return lido;
}

function detector(contagens: { forte: number; provavel: number; atencao: number; excesso_14_dias: number | null }): DetectorDeFrete {
  const lido = lerDetectorFrete({
    janela: { inicio: "2026-06-26", corte: "2026-09-10", fim: "2026-09-23" },
    resumo: {
      analisados: 745,
      anuncios: 729,
      com_historico: 665,
      com_irmaos: 456,
      com_pares: 325,
      normal: 684,
      ...contagens,
      skus: 399,
      skus_com_peso: 17,
    },
    faixas: [],
    alertas: [],
  });

  if (lido === null) throw new Error("fixture de frete fora do contrato");

  return lido;
}

const PRODUTOS: ProdutosDoFaturamento = {
  maiorReceita: [],
  menorMargem: [],
  skusComVenda: 400,
  skusAbaixoDaMargem: 9,
  skusMargemNegativa: 4,
};

/** A margem de 25,0% para 21,3%: queda relevante, tom de perigo, como a central julga. */
const MARGEM_EM_QUEDA: Indicador = {
  id: "margem",
  grupo: "resultado",
  metricId: "margem_venda",
  label: "Margem",
  formula: "resultado ÷ receita coberta",
  valor: 0.213,
  formato: "percentual",
  comparado: { atual: 0.213, anterior: 0.25, formato: "percentual", escala: "fracao", polaridade: "maior-melhor", rotulo: null },
  variacao: { anterior: 0.25, diferenca: -0.037, relativa: null, direcao: "desce", relevante: true, tom: "perigo" },
  semComparacao: null,
  ressalva: null,
};

/** Setembro em curso, R$ 1.000 abaixo de um esperado de R$ 10.000: 10% atrás, perigo. */
const META_ATRASADA: MetaDoMes = {
  mes: "2026-09-01",
  fim: "2026-09-30",
  hoje: "2026-09-24",
  situacao: "em_curso",
  inicio_historico: "2026-06-01",
  meta: 30_000,
  realizado: 9_000,
  realizado_ate_ontem: 9_000,
  realizado_hoje: 0,
  dias_no_mes: 30,
  dias_completos: 23,
  dias_restantes: 7,
  atingimento: 0.3,
  faltam: 21_000,
  esperado_ate_ontem: 10_000,
  diferenca_ritmo: -1_000,
  media_diaria: 391.3,
  meta_diaria_necessaria: 3_000,
  aumento_necessario: 6.67,
  perfil_semanal: true,
  fatores: [],
  projecao: null,
  ano_anterior: null,
  dias_sem_venda: 0,
};

function entrada(parcial: Partial<EntradaDaAtencao> = {}): EntradaDaAtencao {
  return {
    sinaisAds: sinaisAds({ critico: 2, abaixo_meta: 3, atencao: 1, escala: 4 }),
    detector: detector({ forte: 1, provavel: 7, atencao: 12, excesso_14_dias: 2400 }),
    produtos: PRODUTOS,
    margem: MARGEM_EM_QUEDA,
    meta: META_ATRASADA,
    periodo: "entre 25/08/2026 e 23/09/2026",
    hrefFaturamento: "/faturamento?from=2026-08-25&to=2026-09-23",
    ...parcial,
  };
}

describe("montarAtencao", () => {
  it("do crítico para a escala; dentro do nível, o que tem mais itens primeiro", () => {
    const itens = montarAtencao(entrada());

    expect(itens.map((i) => [i.severidade, i.categoria, i.quantidade])).toEqual([
      ["critico", "Produtos", 4],
      ["critico", "Ads", 2],
      ["critico", "Frete", 1],
      ["atencao", "Frete", 7],
      ["atencao", "Ads", 3],
      ["atencao", "Margem", 1],
      ["atencao", "Meta", 1],
      ["otimizacao", "Frete", 12],
      ["otimizacao", "Produtos", 5],
      ["otimizacao", "Ads", 1],
      ["oportunidade", "Ads", 4],
    ]);
    expect(contarPorSeveridade(itens)).toEqual({ critico: 7, atencao: 12, otimizacao: 18, oportunidade: 4 });
  });

  it("cada frase leva o número e o caminho para o recorte", () => {
    const itens = montarAtencao(entrada());
    const texto = (categoria: string, severidade: string): string =>
      limpo(itens.find((i) => i.categoria === categoria && i.severidade === severidade)?.texto ?? "");

    expect(texto("Produtos", "critico")).toBe("4 produtos venderam com margem negativa entre 25/08/2026 e 23/09/2026.");
    expect(texto("Frete", "atencao")).toBe(
      "7 anúncios têm provável problema de frete — nos que pedem revisão, cerca de R$ 2.400,00 de frete a mais em 14 dias.",
    );
    expect(texto("Margem", "atencao")).toBe(
      "A margem sobre a venda caiu 3,7 p.p. contra o período anterior entre 25/08/2026 e 23/09/2026.",
    );
    expect(texto("Meta", "atencao")).toBe("A meta do mês está R$ 1.000,00 abaixo do ritmo necessário.");
    expect(itens.find((i) => i.categoria === "Produtos")?.href).toBe("/faturamento?from=2026-08-25&to=2026-09-23");
    expect(itens.find((i) => i.categoria === "Ads" && i.severidade === "oportunidade")?.href).toBe("/central/ads?nivel=escala");
  });

  it("fonte que não carregou some da lista — nunca vira zero", () => {
    const itens = montarAtencao(entrada({ sinaisAds: null, detector: null, produtos: null, margem: null, meta: null }));

    expect(itens).toEqual([]);
  });

  it("contagem zero não vira item, e margem que sobe não é alerta", () => {
    const itens = montarAtencao(
      entrada({
        sinaisAds: sinaisAds({ critico: 0, abaixo_meta: 0, atencao: 0, escala: 0 }),
        detector: detector({ forte: 0, provavel: 0, atencao: 0, excesso_14_dias: null }),
        produtos: { ...PRODUTOS, skusAbaixoDaMargem: 0, skusMargemNegativa: 0 },
        margem: { ...MARGEM_EM_QUEDA, variacao: { anterior: 0.2, diferenca: 0.013, relativa: null, direcao: "sobe", relevante: true, tom: "ok" } },
        meta: { ...META_ATRASADA, diferenca_ritmo: 500 },
      }),
    );

    expect(itens).toEqual([]);
  });

  it("meta atrás por até 5% é otimização, não atenção", () => {
    const itens = montarAtencao(entrada({ meta: { ...META_ATRASADA, diferenca_ritmo: -400 } }));

    expect(itens.find((i) => i.categoria === "Meta")?.severidade).toBe("otimizacao");
  });
});

describe("rotuloDaContagem", () => {
  it("singular e plural, no vocabulário do pedido", () => {
    expect(rotuloDaContagem("critico", 1)).toBe("1 alerta crítico");
    expect(rotuloDaContagem("critico", 3)).toBe("3 alertas críticos");
    expect(rotuloDaContagem("atencao", 7)).toBe("7 itens que precisam de atenção");
    expect(rotuloDaContagem("otimizacao", 12)).toBe("12 oportunidades de otimização");
    expect(rotuloDaContagem("oportunidade", 1)).toBe("1 oportunidade de escala");
  });
});
