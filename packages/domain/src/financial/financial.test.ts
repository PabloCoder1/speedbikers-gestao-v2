import { describe, expect, it } from "vitest";

import {
  calcularMargemProduto,
  calcularPontoDeEquilibrio,
  calcularPrecoParaMargemDesejada,
  calcularTributosEntidade,
  chaveIdempotenciaDespesa,
  consolidarMargemProdutos,
  montarDreGerencial,
  ratearDespesa,
  resumirOrcadoRealizado,
  selecionarConfigTributariaVigente,
  simularCenarioFinanceiro,
} from "./index.js";

describe("Margem do Produto — fórmula oficial", () => {
  it("valida o exemplo oficial: venda 100, recebido 80, custo 50 -> resultado 30, margem 30%", () => {
    const res = calcularMargemProduto({
      valorVenda: 100,
      valorLiquidoRecebido: 80,
      custoProduto: 50,
    });

    expect(res.coberto).toBe(true);
    expect(res.resultado).toBe(30);
    expect(res.margemFracao).toBeCloseTo(0.3, 6);
    expect(res.margemPercentual).toBe(30);
    expect(res.motivoIndefinido).toBeNull();
  });

  it("trata prejuízo (margem negativa) sem truncar em zero", () => {
    const res = calcularMargemProduto({
      valorVenda: 100,
      valorLiquidoRecebido: 75,
      custoProduto: 90,
    });

    expect(res.coberto).toBe(true);
    expect(res.resultado).toBe(-15);
    expect(res.margemPercentual).toBe(-15);
  });

  it("não trata custo desconhecido ou zero como zero silenciosamente", () => {
    expect(calcularMargemProduto({ valorVenda: 100, valorLiquidoRecebido: 80, custoProduto: null }).coberto).toBe(false);
    expect(calcularMargemProduto({ valorVenda: 100, valorLiquidoRecebido: 80, custoProduto: 0 }).coberto).toBe(false);
    expect(calcularMargemProduto({ valorVenda: 100, valorLiquidoRecebido: null, custoProduto: 50 }).coberto).toBe(false);
  });

  it("exclui vendas canceladas e evita divisão por zero", () => {
    expect(
      calcularMargemProduto({ valorVenda: 100, valorLiquidoRecebido: 80, custoProduto: 50, cancelada: true }).coberto,
    ).toBe(false);
    expect(calcularMargemProduto({ valorVenda: 0, valorLiquidoRecebido: 0, custoProduto: 50 }).coberto).toBe(false);
  });

  it("consolida por ponderação monetária, jamais média simples de margens", () => {
    // Produto A: venda 1000, recebido 800, custo 700 -> margem 10% (resultado 100)
    // Produto B: venda 100, recebido 90, custo 40 -> margem 50% (resultado 50)
    // Média simples errada seria 30%; ponderada correta é (100 + 50) / 1100 = 13,64%
    const consolidado = consolidarMargemProdutos([
      { valorVenda: 1000, valorLiquidoRecebido: 800, custoProduto: 700 },
      { valorVenda: 100, valorLiquidoRecebido: 90, custoProduto: 40 },
      { valorVenda: 200, valorLiquidoRecebido: 160, custoProduto: null }, // sem custo
      { valorVenda: 300, valorLiquidoRecebido: 240, custoProduto: 100, cancelada: true }, // cancelada
    ]);

    expect(consolidado.itensValidos).toBe(3);
    expect(consolidado.itensCobertos).toBe(2);
    expect(consolidado.itensCancelados).toBe(1);
    expect(consolidado.itensSemCusto).toBe(1);
    expect(consolidado.resultadoTotal).toBe(150);
    expect(consolidado.margemPercentual).toBe(13.64);
    expect(consolidado.coberturaReceita).toBeCloseTo(1100 / 1300, 6);
  });

  it("calcula preço de venda necessário para margem desejada", () => {
    // custo 50 + frete 10 = 60; comissão 12%, imposto 8%, margem desejada 20% => denominador 0.60 => preço R$ 100,00
    const preco = calcularPrecoParaMargemDesejada({
      custo: 50,
      freteFixo: 10,
      comissaoFracao: 0.12,
      impostoFracao: 0.08,
      margemDesejadaFracao: 0.2,
    });

    expect(preco).toBe(100);
    expect(
      calcularPrecoParaMargemDesejada({
        custo: 50,
        freteFixo: 10,
        comissaoFracao: 0.5,
        impostoFracao: 0.2,
        margemDesejadaFracao: 0.35,
      }),
    ).toBeNull();
  });
});

describe("DRE Gerencial e Ponto de Equilíbrio", () => {
  it("monta DRE completa sem dupla contagem e calcula ponto de equilíbrio", () => {
    const dre = montarDreGerencial({
      faturamentoBruto: 100000,
      impostosSobreVendas: 8000,
      cmv: 40000,
      comissoesMarketplace: 14000,
      custosLogisticos: 8000,
      investimentoAds: 5000,
      despesasFixas: 15000,
    });

    // Receita líquida = 92.000; Lucro bruto = 52.000; Margem contribuição = 52.000 - 14.000 - 8.000 - 5.000 = 25.000 (25%)
    // Resultado operacional = 25.000 - 15.000 = 10.000 (10%)
    // Ponto de equilíbrio = 15.000 / 0.25 = 60.000
    expect(dre.receitaLiquida).toBe(92000);
    expect(dre.lucroBruto).toBe(52000);
    expect(dre.margemContribuicaoValor).toBe(25000);
    expect(dre.margemContribuicaoFracao).toBeCloseTo(0.25, 6);
    expect(dre.resultadoOperacional).toBe(10000);
    expect(dre.resultadoLiquidoGerencial).toBe(10000);
    expect(dre.margemLiquidaFinal).toBeCloseTo(0.1, 6);
    expect(dre.pontoDeEquilibrio.status).toBe("alcancavel");
    expect(dre.pontoDeEquilibrio.faturamentoEquilibrio).toBe(60000);
    expect(dre.pontoDeEquilibrio.folgaEmReais).toBe(40000);
    expect(dre.lacunas).toHaveLength(0);
  });

  it("sinaliza ausência de despesas fixas sem fingir zero", () => {
    const dre = montarDreGerencial({
      faturamentoBruto: 50000,
      impostosSobreVendas: 4000,
      cmv: 20000,
      comissoesMarketplace: 7000,
      custosLogisticos: 4000,
      investimentoAds: 2500,
      despesasFixas: null,
    });

    expect(dre.margemContribuicaoValor).toBe(12500);
    expect(dre.resultadoOperacional).toBeNull();
    expect(dre.resultadoLiquidoGerencial).toBeNull();
    expect(dre.pontoDeEquilibrio.status).toBe("sem_despesas_fixas");
    expect(dre.lacunas.length).toBeGreaterThan(0);
  });

  it("trata margem de contribuição nula ou negativa no ponto de equilíbrio", () => {
    const pe = calcularPontoDeEquilibrio({
      despesasFixas: 10000,
      margemContribuicaoFracao: -0.05,
      faturamentoAtual: 50000,
    });

    expect(pe.status).toBe("margem_nao_positiva");
    expect(pe.faturamentoEquilibrio).toBeNull();
  });
});

describe("Custos Fixos, Variáveis, Rateio e Orçamento vs. Realizado", () => {
  it("rateia por faturamento conservando centavos exatamente", () => {
    const res = ratearDespesa(100, "faturamento", [
      { destinoId: "c1", rotulo: "Conta 1", peso: 1 },
      { destinoId: "c2", rotulo: "Conta 2", peso: 1 },
      { destinoId: "c3", rotulo: "Conta 3", peso: 1 },
    ]);

    expect(res.ok).toBe(true);
    if (res.ok) {
      const soma = Math.round(res.parcelas.reduce((acc, p) => acc + p.valor, 0) * 100) / 100;
      expect(soma).toBe(100);
      expect(res.parcelas.every((p) => p.origem === "rateado")).toBe(true);
    }
  });

  it("rejeita rateio manual que não fecha com o total", () => {
    const res = ratearDespesa(500, "manual", [
      { destinoId: "c1", rotulo: "Conta 1", peso: 0, valorManual: 200 },
      { destinoId: "c2", rotulo: "Conta 2", peso: 0, valorManual: 250 },
    ]);

    expect(res.ok).toBe(false);
  });

  it("gera chave de idempotência determinística para evitar duplicidade recorrente", () => {
    const k1 = chaveIdempotenciaDespesa({ organizationId: "org1", origemRecorrenciaId: "rec1", competenciaYm: "2026-11" });
    const k2 = chaveIdempotenciaDespesa({ organizationId: "org1", origemRecorrenciaId: "rec1", competenciaYm: "2026-11" });
    const k3 = chaveIdempotenciaDespesa({ organizationId: "org1", origemRecorrenciaId: "rec1", competenciaYm: "2026-12" });

    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it("consolida Orçamento vs. Realizado ignorando canceladas e separando diretas e rateadas", () => {
    const resumo = resumirOrcadoRealizado([
      { classificacao: "fixo", status: "paga", valorPrevisto: 5000, valorRealizado: 5200, metodoRateio: "faturamento" },
      { classificacao: "variavel", status: "paga", valorPrevisto: 1000, valorRealizado: 900, metodoRateio: "direto" },
      { classificacao: "fixo", status: "cancelada", valorPrevisto: 9999, valorRealizado: 9999, metodoRateio: "direto" },
    ]);

    expect(resumo.totalPrevisto).toBe(6000);
    expect(resumo.totalRealizado).toBe(6100);
    expect(resumo.desvioReais).toBe(100);
    expect(resumo.totalRateadas).toBe(5200);
    expect(resumo.totalDiretas).toBe(900);
  });
});

describe("Gestão Tributária Multi-Regime e Vigência Histórica", () => {
  it("respeita vigência histórica sem alterar meses anteriores", () => {
    const configs = [
      {
        id: "1",
        entityId: "e1",
        regime: "simples_nacional" as const,
        validFrom: "2026-01-01",
        aliquotaNominal: 0.08,
        aliquotaEfetivaVendas: 0.065,
        validadoContabilidade: true,
      },
      {
        id: "2",
        entityId: "e1",
        regime: "simples_nacional" as const,
        validFrom: "2026-07-01",
        aliquotaNominal: 0.095,
        aliquotaEfetivaVendas: 0.082,
        validadoContabilidade: true,
      },
    ];

    expect(selecionarConfigTributariaVigente(configs, "2026-06-15")?.id).toBe("1");
    expect(selecionarConfigTributariaVigente(configs, "2026-07-01")?.id).toBe("2");
    expect(selecionarConfigTributariaVigente(configs, "2025-12-31")).toBeNull();
  });

  it("calcula Lucro Real considerando créditos tributários e tributo sobre lucro positivo", () => {
    const res = calcularTributosEntidade({
      config: {
        id: "lr1",
        entityId: "e2",
        regime: "lucro_real",
        validFrom: "2026-01-01",
        aliquotaNominal: 0.2725,
        aliquotaEfetivaVendas: 0.2725,
        creditosTributariosFracao: 0.2,
        aliquotaSobreLucro: 0.24,
        validadoContabilidade: true,
      },
      faturamentoBruto: 100000,
      cmv: 50000,
      lucroOperacionalAntesIr: 10000,
    });

    // Débito = 27.250; Crédito = 10.000 -> Líquido vendas = 17.250; IR/CSLL = 2.400 -> Total = 19.650
    expect(res.impostoSobreVendas).toBe(27250);
    expect(res.creditosAbatidos).toBe(10000);
    expect(res.impostoLiquidoVendas).toBe(17250);
    expect(res.tributosSobreLucro).toBe(2400);
    expect(res.totalTributos).toBe(19650);
    expect(res.natureza).toBe("estimativa_gerencial");
  });
});

describe("Simulador Financeiro (What-If)", () => {
  it("simula aumento de preço de 5% e corte de despesas fixas sem alterar a base", () => {
    const sim = simularCenarioFinanceiro(
      {
        faturamentoBruto: 100000,
        impostosSobreVendas: 8000,
        cmv: 40000,
        comissoesMarketplace: 14000,
        custosLogisticos: 8000,
        investimentoAds: 5000,
        despesasFixas: 15000,
      },
      {
        deltaPreco: 0.05,
        deltaDespesasFixasReais: -2000,
      },
    );

    expect(sim.base.faturamentoBruto).toBe(100000);
    expect(sim.simulado.faturamentoBruto).toBe(105000);
    expect(sim.impactoFaturamento).toBe(5000);
    expect(sim.simulado.resultadoLiquidoGerencial).not.toBeNull();
    expect((sim.impactoResultadoLiquido ?? 0)).toBeGreaterThan(5000);
  });
});
