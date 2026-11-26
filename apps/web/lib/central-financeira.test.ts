import { describe, expect, it } from "vitest";

import {
  lerAlvoMetaFinanceira,
  lerEscopoMetaFinanceira,
  lerTipoMetaFinanceira,
  rotuloEscopoMetaFinanceira,
  rotuloTipoMetaFinanceira,
} from "./metas-imposto";
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
