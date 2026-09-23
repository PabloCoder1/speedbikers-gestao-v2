import { describe, expect, it } from "vitest";

import {
  estimar,
  lerCampanhaSinal,
  lerSinaisAds,
  paraRevisarAds,
  roasDeEquilibrio,
  type CampanhaSinal,
  type SinaisAds,
  type SinaisDaCampanha,
} from "./sinais-ads";

function limpo(texto: string): string {
  return texto.replaceAll(String.fromCharCode(160), " ");
}

const SEM_SINAL = {
  sem_venda: false,
  roas_abaixo_de_1: false,
  abaixo_da_meta: false,
  cpc_sobe_conversao_cai: false,
  gasto_sobe_roas_cai: false,
  ctr_baixo: false,
  conversao_baixa: false,
  no_teto_acima_da_meta: false,
};

/**
 * Uma campanha do protótipo em produção (semana de 14 a 20/09/2026):
 * "[HML] CA1 26| PFT | AUTO 6%", em atenção — o CPC foi de 0,61 para 1,01 e a
 * conversão de 6,8% para 4,8% dos cliques.
 */
const CAMPANHA = {
  ml_account_id: "418ceddd-0000-4000-8000-000000000000",
  conta: "Speedbikers (loja 1)",
  campaign_id: 351234,
  nome: "[HML] CA1 26| PFT | AUTO 6%",
  status: "active",
  estrategia: "PROFITABILITY",
  orcamento: 170,
  roas_alvo: 13,
  acos_alvo: 0.077,
  nivel: "atencao",
  investimento: 481,
  receita_ads: 5146.7,
  unidades: 23,
  cliques: 476,
  impressoes: 120000,
  dias: 7,
  dias_no_teto: 0,
  roas: 10.7,
  acos: 0.0935,
  ctr: 0.004,
  cpc: 1.01,
  conversao: 0.048,
  cpa: 20.91,
  ticket: 223.77,
  uso_orcamento: 0.41,
  investimento_anterior: 505,
  receita_ads_anterior: 9746.5,
  unidades_anterior: 56,
  cliques_anterior: 828,
  roas_anterior: 19.3,
  cpc_anterior: 0.61,
  conversao_anterior: 0.068,
  sinais: { ...SEM_SINAL, cpc_sobe_conversao_cai: true },
};

const RESPOSTA = {
  janela: {
    inicio: "2026-09-14",
    fim: "2026-09-20",
    anterior_inicio: "2026-09-07",
    anterior_fim: "2026-09-13",
    dias_pendentes: ["2026-09-21", "2026-09-22"],
  },
  referencias: { ctr_mediano: 0.0038, conversao_mediana: 0.0568 },
  resumo: {
    campanhas: 51,
    critico: 0,
    abaixo_meta: 5,
    atencao: 4,
    escala: 6,
    normal: 34,
    pausada: 2,
    investimento: 21000,
    receita_ads: 370000,
    roas: 17.62,
    investimento_anterior: 20000,
    receita_ads_anterior: 360000,
    roas_anterior: 18,
  },
  campanhas: [CAMPANHA],
};

function sinais(): SinaisAds {
  const lido = lerSinaisAds(RESPOSTA);

  if (lido === null) throw new Error("fixture fora do contrato");

  return lido;
}

function campanha(parcial: Omit<Partial<CampanhaSinal>, "sinais"> & { sinais?: Partial<SinaisDaCampanha> }): CampanhaSinal {
  const base = sinais().campanhas[0];

  if (base === undefined) throw new Error("fixture sem campanha");

  return { ...base, ...parcial, sinais: { ...SEM_SINAL, ...parcial.sinais } };
}

describe("lerSinaisAds", () => {
  it("lê a janela com os dias pendentes, as referências e as campanhas", () => {
    const s = sinais();

    expect(s.janela.dias_pendentes).toEqual(["2026-09-21", "2026-09-22"]);
    expect(s.referencias.conversao_mediana).toBe(0.0568);
    expect(s.campanhas[0]?.nivel).toBe("atencao");
    expect(s.campanhas[0]?.sinais.cpc_sobe_conversao_cai).toBe(true);
  });

  it("devolve null fora do contrato", () => {
    expect(lerSinaisAds({ ...RESPOSTA, campanhas: [{ ...CAMPANHA, nivel: "urgente" }] })).toBeNull();
    expect(lerSinaisAds({ ...RESPOSTA, campanhas: [{ ...CAMPANHA, roas: "alto" }] })).toBeNull();
    expect(lerSinaisAds({ ...RESPOSTA, janela: { ...RESPOSTA.janela, dias_pendentes: null } })).toBeNull();
    expect(lerSinaisAds(null)).toBeNull();
  });

  it("aceita a semana sem dado consolidado (janela nula e nenhuma campanha)", () => {
    const vazia = lerSinaisAds({
      ...RESPOSTA,
      janela: { inicio: null, fim: null, anterior_inicio: null, anterior_fim: null, dias_pendentes: [] },
      referencias: { ctr_mediano: null, conversao_mediana: null },
      campanhas: [],
    });

    expect(vazia?.janela.fim).toBeNull();
  });

  it("paraRevisarAds soma crítico, abaixo da meta e atenção — escala é oportunidade", () => {
    expect(paraRevisarAds(sinais().resumo)).toBe(9);
  });
});

describe("lerCampanhaSinal", () => {
  it("atenção: CPC em alta com conversão em queda, com a interpretação e o tom de análise", () => {
    const l = lerCampanhaSinal(campanha({ sinais: { cpc_sobe_conversao_cai: true } }), sinais().referencias, null);

    expect(l.motivos.map(limpo)).toEqual([
      "O CPC subiu 66% (de R$ 0,61 para R$ 1,01) enquanto a conversão caiu 29% (de 6,8% para 4,8% dos cliques).",
    ]);
    expect(l.interpretacao).toContain("concorrência no leilão");
    expect(l.sugestao).toContain("justificam análise antes de continuar escalando");
    expect(l.sugestao).not.toMatch(/pause/i);
  });

  it("crítico sem venda: considere reduzir e avaliar pausa só se o comportamento permanecer", () => {
    const c = campanha({ nivel: "critico", unidades: 0, receita_ads: 0, roas: 0, cliques: 380, sinais: { sem_venda: true } });
    const l = lerCampanhaSinal(c, sinais().referencias, null);

    expect(limpo(l.motivos[0] ?? "")).toBe(
      "Gastou R$ 481,00 em 7 dias sem nenhuma venda atribuída pelo Mercado Livre (380 cliques).",
    );
    expect(l.sugestao).toBe(
      "Considere reduzir o orçamento e investigar preço, frete, estoque e a página do produto. Avaliar pausa caso o comportamento permaneça.",
    );
  });

  it("abaixo da meta com CTR baixo: criativo e oferta", () => {
    const c = campanha({ nivel: "abaixo_meta", roas: 9, roas_alvo: 14, ctr: 0.002, sinais: { abaixo_da_meta: true, ctr_baixo: true } });
    const l = lerCampanhaSinal(c, sinais().referencias, null);

    expect(limpo(l.motivos[0] ?? "")).toBe("ROAS 9,00x contra a meta de 14,00x da campanha (36% abaixo), com R$ 481,00 investidos.");
    expect(l.interpretacao).toBe(
      "CTR de 0,2% contra 0,4% da mediana das suas campanhas: o anúncio aparece, mas atrai pouco clique — o criativo ou a oferta pode estar pouco atrativo.",
    );
    expect(l.sugestao).toContain("testar nova imagem e outro título");
  });

  it("abaixo da meta com conversão baixa: a página não converte", () => {
    const c = campanha({ nivel: "abaixo_meta", roas: 9, roas_alvo: 14, conversao: 0.02, sinais: { abaixo_da_meta: true, conversao_baixa: true } });
    const l = lerCampanhaSinal(c, sinais().referencias, null);

    expect(l.interpretacao).toContain("a página ou o produto não converte");
    expect(l.sugestao).toContain("preço, frete, prazo de entrega, avaliações, reputação, descrição, fotos, estoque e concorrência");
  });

  it("escala: acima da meta e no teto; margem baixa segura a recomendação", () => {
    const c = campanha({
      nivel: "escala",
      roas: 17.1,
      roas_alvo: 14,
      uso_orcamento: 0.95,
      dias_no_teto: 6,
      receita_ads: 11000,
      receita_ads_anterior: 10000,
      acos: 0.058,
      sinais: { no_teto_acima_da_meta: true },
    });

    const boa = lerCampanhaSinal(c, sinais().referencias, 0.25);

    expect(limpo(boa.motivos[0] ?? "")).toBe(
      "ROAS 17,10x acima da meta de 14,00x, usando 95,0% do orçamento diário (6 de 7 dias no teto), com as vendas com Ads 10% acima da semana anterior.",
    );
    expect(boa.sugestao).toBe("Campanha potencialmente escalável. Avaliar aumento gradual de orçamento.");

    const apertada = lerCampanhaSinal(c, sinais().referencias, 0.12);

    expect(limpo(apertada.sugestao)).toBe(
      "Apesar do bom retorno publicitário, a margem estimada depois do Ads é de 6,2%. Não aumentar o orçamento antes de revisar custos, preço, frete e comissão.",
    );

    expect(lerCampanhaSinal(c, sinais().referencias, null).sugestao).toContain("a margem do período não é conhecida");
  });

  it("gasto sobe e ROAS cai: evitar escalar", () => {
    const c = campanha({
      nivel: "atencao",
      investimento: 600,
      investimento_anterior: 400,
      roas: 12,
      roas_anterior: 18,
      sinais: { gasto_sobe_roas_cai: true },
    });
    const l = lerCampanhaSinal(c, sinais().referencias, null);

    expect(limpo(l.motivos[0] ?? "")).toBe(
      "O gasto subiu 50% (de R$ 400,00 para R$ 600,00) e o ROAS caiu 33% (de 18,00x para 12,00x).",
    );
    expect(l.sugestao).toContain("Evitar escalar por enquanto");
  });
});

describe("estimativa pela margem média", () => {
  it("lucro = vendas × margem − investimento; margem depois do Ads = margem − ACOS", () => {
    const e = estimar({ receita_ads: 10_000, investimento: 500, acos: 0.05 }, 0.25);

    expect(e.lucro).toBe(2_000);
    expect(e.margemAposAds).toBeCloseTo(0.2);
  });

  it("sem margem, nada é estimado; o ROAS de equilíbrio é 1 ÷ margem", () => {
    expect(estimar({ receita_ads: 10_000, investimento: 500, acos: 0.05 }, null)).toEqual({ lucro: null, margemAposAds: null });
    expect(roasDeEquilibrio(0.25)).toBe(4);
    expect(roasDeEquilibrio(null)).toBeNull();
    expect(roasDeEquilibrio(-0.1)).toBeNull();
  });
});
