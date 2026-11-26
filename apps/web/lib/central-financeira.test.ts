import { describe, expect, it } from "vitest";

import { montarAtencao } from "./central-atencao";
import {
  avaliarMetaFinanceira,
  lerAlvoMetaFinanceira,
  lerEscopoMetaFinanceira,
  lerTipoMetaFinanceira,
  rotuloEscopoMetaFinanceira,
  rotuloTipoMetaFinanceira,
} from "./metas-imposto";
import { classificarMatrizRentabilidade, type ProdutoDoRanking } from "./ranking-produtos";
import { acosDeEquilibrio, resumirFinanceiroAds, type CampanhaSinal } from "./sinais-ads";

describe("Metas financeiras expandidas", () => {
  it("valida tipos, escopos e alvos conforme unidade (moeda, percentual e contagem)", () => {
    expect(lerTipoMetaFinanceira("lucro_liquido")).toEqual({ ok: true, valor: "lucro_liquido" });
    expect(lerTipoMetaFinanceira("inexistente").ok).toBe(false);

    expect(lerEscopoMetaFinanceira("brand")).toEqual({ ok: true, valor: "brand" });
    expect(rotuloEscopoMetaFinanceira("brand", "Off Racer")).toBe("Marca específica: Off Racer");
    expect(rotuloTipoMetaFinanceira("margem_contribuicao")).toBe("Margem de contribuição (%)");

    expect(lerAlvoMetaFinanceira("150.000,50", "lucro_liquido")).toEqual({ ok: true, valor: 150000.5 });
    expect(lerAlvoMetaFinanceira("28,5", "margem_produto")).toEqual({ ok: true, valor: 0.285 });
    expect(lerAlvoMetaFinanceira("1.200", "quantidade_vendas")).toEqual({ ok: true, valor: 1200 });
    expect(lerAlvoMetaFinanceira("12,5", "quantidade_vendas").ok).toBe(false);
  });
});

describe("Inteligência financeira de Ads (ACOS equilíbrio, projeção e risco)", () => {
  const baseCampanha: CampanhaSinal = {
    ml_account_id: "acc-1",
    conta: "Speed",
    campaign_id: 1,
    nome: "Campanha A",
    status: "active",
    estrategia: "profitability",
    orcamento: 200,
    roas_alvo: 5,
    acos_alvo: 0.2,
    nivel: "normal",
    investimento: 700,
    receita_ads: 2800,
    unidades: 20,
    cliques: 500,
    impressoes: 10000,
    dias: 7,
    dias_no_teto: 2,
    roas: 4,
    acos: 0.25,
    ctr: 0.05,
    cpc: 1.4,
    conversao: 0.04,
    cpa: 35,
    ticket: 140,
    uso_orcamento: 0.5,
    investimento_anterior: 600,
    receita_ads_anterior: 2400,
    unidades_anterior: 18,
    cliques_anterior: 450,
    roas_anterior: 4,
    cpc_anterior: 1.33,
    conversao_anterior: 0.04,
    sinais: {
      sem_venda: false,
      roas_abaixo_de_1: false,
      abaixo_da_meta: false,
      cpc_sobe_conversao_cai: false,
      gasto_sobe_roas_cai: false,
      ctr_baixo: false,
      conversao_baixa: false,
      no_teto_acima_da_meta: false,
    },
  };

  it("calcula ACOS de equilíbrio igual à margem antes do Ads", () => {
    expect(acosDeEquilibrio(0.22)).toBe(0.22);
    expect(acosDeEquilibrio(0)).toBeNull();
    expect(acosDeEquilibrio(-0.05)).toBeNull();
    expect(acosDeEquilibrio(null)).toBeNull();
  });

  it("projeta orçamento mensal e detecta campanhas com risco de prejuízo após Ads", () => {
    const pausada: CampanhaSinal = { ...baseCampanha, campaign_id: 2, nivel: "pausada", orcamento: 500, acos: 0.5 };
    const resumo = resumirFinanceiroAds([baseCampanha, pausada], 700, 0.2);

    // Só a campanha ativa entra no orçamento diário (200 -> 6000/mês)
    expect(resumo.orcamentoDiarioAtivo).toBe(200);
    expect(resumo.orcamentoMensalEstimado).toBe(6000);
    // 700 / 7 * 30 = 3000
    expect(resumo.projecaoMensalRitmo).toBe(3000);
    // ACOS 25% > margem 20% => margem após Ads = -5% => 1 campanha em risco (pausada fica fora)
    expect(resumo.campanhasRiscoPrejuizo).toBe(1);
    expect(resumo.investimentoEmRisco).toBe(700);
  });
});

describe("Avaliação de Metas Financeiras e Alertas de Custos na Atenção", () => {
  it("respeita polaridade em metas de receita/lucro (maior melhor) e tetos de Ads/despesas (menor melhor)", () => {
    expect(avaliarMetaFinanceira("lucro_liquido", 100000, 105000).status).toBe("ok");
    expect(avaliarMetaFinanceira("lucro_liquido", 100000, 90000).status).toBe("atencao");
    expect(avaliarMetaFinanceira("lucro_liquido", 100000, 50000).status).toBe("perigo");

    expect(avaliarMetaFinanceira("investimento_ads", 10000, 8000).status).toBe("ok");
    expect(avaliarMetaFinanceira("investimento_ads", 10000, 9500).status).toBe("atencao");
    expect(avaliarMetaFinanceira("investimento_ads", 10000, 12000).status).toBe("perigo");
  });

  it("gera alertas de Custos na Central de Atenção para contas vencidas e estouro > 10% do orçamento", () => {
    const itens = montarAtencao({
      sinaisAds: null,
      detector: null,
      produtos: null,
      margem: null,
      meta: null,
      periodo: "nos últimos 30 dias",
      hrefRanking: "/central/produtos",
      despesas: { atrasadasCount: 2, totalPrevisto: 10000, totalRealizado: 12500 },
    });

    expect(itens.filter((i) => i.categoria === "Custos")).toHaveLength(2);
    expect(itens.some((i) => i.texto.includes("2 despesas operacionais estão vencida(s)"))).toBe(true);
    expect(itens.some((i) => i.texto.includes("ultrapassaram o orçamento previsto"))).toBe(true);
  });

  it("classifica produtos em quadrantes mutuamente exclusivos sem zerar margem desconhecida", () => {
    const base: ProdutoDoRanking = {
      sku_id: "s1",
      sku: "SKU-1",
      title: "Produto",
      unidades: 10,
      pedidos: 10,
      receita_bruta: 1000,
      taxas_ml: 120,
      pedidos_cobertos: 10,
      receita_coberta: 1000,
      taxas_ml_cobertas: 120,
      frete_vendedor: 100,
      custo_produtos: 500,
      resultado_venda: 280,
      margem_venda: 0.28,
      imposto: null,
      resultado_apos_imposto: null,
      margem_apos_imposto: null,
      custo_atual: false,
      pedidos_anterior: 5,
      receita_anterior: 500,
      margem_anterior: 0.25,
      variacao_receita: 1,
      variacao_margem: 0.03,
      frete_sobre_receita: 0.1,
    };

    const matriz = classificarMatrizRentabilidade(
      [
        { ...base, sku_id: "estrela", receita_bruta: 5000, margem_venda: 0.25 },
        { ...base, sku_id: "alto-baixa", receita_bruta: 4000, margem_venda: 0.05, frete_sobre_receita: 0.18 },
        { ...base, sku_id: "joia", receita_bruta: 500, margem_venda: 0.32 },
        { ...base, sku_id: "prejuizo", receita_bruta: 3000, margem_venda: -0.04 },
        { ...base, sku_id: "sem-cobertura", receita_bruta: 800, margem_venda: null, custo_atual: true },
      ],
      0.1,
    );

    expect(matriz.estrelas.map((p) => p.sku_id)).toEqual(["estrela"]);
    expect(matriz.altoFaturamentoBaixaMargem.map((p) => p.sku_id)).toEqual(["alto-baixa"]);
    expect(matriz.joiasOcultas.map((p) => p.sku_id)).toEqual(["joia"]);
    expect(matriz.prejuizo.map((p) => p.sku_id)).toEqual(["prejuizo"]);
    expect(matriz.semCobertura.map((p) => p.sku_id)).toEqual(["sem-cobertura"]);
    expect(matriz.fretePesado.map((p) => p.sku_id)).toEqual(["alto-baixa"]);
    expect(matriz.comCustoAtual.map((p) => p.sku_id)).toEqual(["sem-cobertura"]);
  });
});
