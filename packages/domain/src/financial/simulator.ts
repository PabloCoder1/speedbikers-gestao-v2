/**
 * Simulador Financeiro (What-If) — Seção 15 da Missão.
 *
 * Permite simular variações de preço, volume, comissão, impostos, custo (CMV),
 * frete, investimento em ADS e despesas fixas sem alterar nenhum dado real.
 */

import { montarDreGerencial, type DreGerencial } from "./dre.js";

export interface BaseSimulacao {
  readonly faturamentoBruto: number;
  readonly impostosSobreVendas: number;
  readonly cmv: number;
  readonly comissoesMarketplace: number;
  readonly custosLogisticos: number;
  readonly investimentoAds: number;
  readonly despesasFixas: number;
  readonly despesasVariaveis?: number;
}

export interface ParametrosSimulacao {
  /** Variação percentual no preço médio de venda (ex.: 0.05 = +5%, -0.03 = -3%). */
  readonly deltaPreco?: number;
  /** Variação percentual no volume de vendas (ex.: 0.10 = +10% unidades). */
  readonly deltaVolume?: number;
  /** Variação em pontos percentuais na comissão (ex.: 0.01 = +1 p.p. sobre a receita). */
  readonly deltaComissaoPp?: number;
  /** Variação em pontos percentuais no imposto sobre vendas (ex.: 0.02 = +2 p.p.). */
  readonly deltaImpostoPp?: number;
  /** Variação percentual no custo de compra (CMV unitário) (ex.: -0.05 = -5% no custo). */
  readonly deltaCustoCompra?: number;
  /** Variação percentual no custo logístico por venda (ex.: 0.08 = +8% no frete). */
  readonly deltaFrete?: number;
  /** Variação percentual no investimento em ADS (ex.: 0.20 = +20% em Ads). */
  readonly deltaAds?: number;
  /** Variação absoluta (em reais) nas despesas fixas (ex.: +5000 ou -2000). */
  readonly deltaDespesasFixasReais?: number;
}

export interface ResultadoSimulacao {
  readonly base: DreGerencial;
  readonly simulado: DreGerencial;
  readonly impactoFaturamento: number;
  readonly impactoMargemContribuicao: number | null;
  readonly impactoMargemContribuicaoPp: number | null;
  readonly impactoResultadoLiquido: number | null;
  readonly impactoMargemLiquidaPp: number | null;
}

function centavos(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Executa uma simulação financeira pura sobre a base atual, devolvendo
 * a DRE base, a DRE simulada e os impactos diretos.
 */
export function simularCenarioFinanceiro(
  base: BaseSimulacao,
  params: ParametrosSimulacao,
): ResultadoSimulacao {
  const dreBase = montarDreGerencial({
    faturamentoBruto: base.faturamentoBruto,
    impostosSobreVendas: base.impostosSobreVendas,
    cmv: base.cmv,
    comissoesMarketplace: base.comissoesMarketplace,
    custosLogisticos: base.custosLogisticos,
    despesasVariaveis: base.despesasVariaveis ?? 0,
    investimentoAds: base.investimentoAds,
    despesasFixas: base.despesasFixas,
  });

  const fatorPreco = Math.max(0.01, 1 + (params.deltaPreco ?? 0));
  const fatorVolume = Math.max(0, 1 + (params.deltaVolume ?? 0));
  const fatorCusto = Math.max(0, 1 + (params.deltaCustoCompra ?? 0));
  const fatorFrete = Math.max(0, 1 + (params.deltaFrete ?? 0));
  const fatorAds = Math.max(0, 1 + (params.deltaAds ?? 0));

  const novoBruto = centavos(base.faturamentoBruto * fatorPreco * fatorVolume);

  // Taxas percentuais originais sobre o faturamento
  const taxaComissaoBase = base.faturamentoBruto > 0 ? base.comissoesMarketplace / base.faturamentoBruto : 0;
  const taxaImpostoBase = base.faturamentoBruto > 0 ? base.impostosSobreVendas / base.faturamentoBruto : 0;
  const taxaVariavelBase =
    base.faturamentoBruto > 0 && (base.despesasVariaveis ?? 0) > 0
      ? (base.despesasVariaveis ?? 0) / base.faturamentoBruto
      : 0;

  const novaTaxaComissao = Math.max(0, taxaComissaoBase + (params.deltaComissaoPp ?? 0));
  const novaTaxaImposto = Math.max(0, taxaImpostoBase + (params.deltaImpostoPp ?? 0));

  const novosImpostos = centavos(novoBruto * novaTaxaImposto);
  const novasComissoes = centavos(novoBruto * novaTaxaComissao);
  // CMV e frete acompanham o volume (não o reajuste de preço)
  const novoCmv = centavos(base.cmv * fatorVolume * fatorCusto);
  const novoFrete = centavos(base.custosLogisticos * fatorVolume * fatorFrete);
  const novasVariaveis = centavos(novoBruto * taxaVariavelBase);
  const novoAds = centavos(base.investimentoAds * fatorAds);
  const novasFixas = centavos(Math.max(0, base.despesasFixas + (params.deltaDespesasFixasReais ?? 0)));

  const dreSimulada = montarDreGerencial({
    faturamentoBruto: novoBruto,
    impostosSobreVendas: novosImpostos,
    cmv: novoCmv,
    comissoesMarketplace: novasComissoes,
    custosLogisticos: novoFrete,
    despesasVariaveis: novasVariaveis,
    investimentoAds: novoAds,
    despesasFixas: novasFixas,
  });

  const impactoMargemContribuicao =
    dreBase.margemContribuicaoValor !== null && dreSimulada.margemContribuicaoValor !== null
      ? centavos(dreSimulada.margemContribuicaoValor - dreBase.margemContribuicaoValor)
      : null;

  const impactoMargemContribuicaoPp =
    dreBase.margemContribuicaoFracao !== null && dreSimulada.margemContribuicaoFracao !== null
      ? dreSimulada.margemContribuicaoFracao - dreBase.margemContribuicaoFracao
      : null;

  const impactoResultadoLiquido =
    dreBase.resultadoLiquidoGerencial !== null && dreSimulada.resultadoLiquidoGerencial !== null
      ? centavos(dreSimulada.resultadoLiquidoGerencial - dreBase.resultadoLiquidoGerencial)
      : null;

  const impactoMargemLiquidaPp =
    dreBase.margemLiquidaFinal !== null && dreSimulada.margemLiquidaFinal !== null
      ? dreSimulada.margemLiquidaFinal - dreBase.margemLiquidaFinal
      : null;

  return {
    base: dreBase,
    simulado: dreSimulada,
    impactoFaturamento: centavos(novoBruto - base.faturamentoBruto),
    impactoMargemContribuicao,
    impactoMargemContribuicaoPp,
    impactoResultadoLiquido,
    impactoMargemLiquidaPp,
  };
}
