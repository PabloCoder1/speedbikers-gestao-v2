/**
 * Motor tributário gerencial multi-regime e multi-entidade (CNPJ).
 *
 * Princípios obrigatórios (Seção 8 da Missão):
 * - Suporta Simples Nacional, Lucro Presumido, Lucro Real e Configurável.
 * - Não reduz todos os regimes a um percentual único sobre o faturamento:
 *   cada regime respeita sua base de cálculo e permite créditos tributários (Lucro Real)
 *   e ajustes manuais / apuração efetiva.
 * - Toda estimativa gerencial é marcada explicitamente como `estimativa_gerencial`
 *   para nunca ser confundida com guia fiscal oficial.
 * - Respeita vigência histórica (`validFrom <= dataVenda`), sem sobrescrever meses anteriores.
 */

export type RegimeTributario = "simples_nacional" | "lucro_presumido" | "lucro_real" | "configuravel";

export const ROTULO_REGIME_TRIBUTARIO: Readonly<Record<RegimeTributario, string>> = {
  simples_nacional: "Simples Nacional",
  lucro_presumido: "Lucro Presumido",
  lucro_real: "Lucro Real",
  configuravel: "Configurável",
};

export interface ConfiguracaoTributaria {
  readonly id: string;
  readonly entityId: string;
  readonly regime: RegimeTributario;
  /** Data de início da vigência (YYYY-MM-DD). */
  readonly validFrom: string;
  /** Alíquota nominal configurada (fração, ex.: 0.085 = 8,5%). */
  readonly aliquotaNominal: number;
  /** Alíquota efetiva (ex.: Simples Nacional DAS efetivo, ou PIS/COFINS/ICMS sobre vendas). */
  readonly aliquotaEfetivaVendas: number;
  /** Fração estimada de créditos tributários sobre CMV/compras (usada no Lucro Real). */
  readonly creditosTributariosFracao?: number;
  /** Alíquota combinada sobre lucro operacional (ex.: IRPJ+CSLL no Lucro Real), se aplicável. */
  readonly aliquotaSobreLucro?: number;
  /** Indica se a configuração é estimativa gerencial ou validada com contabilidade. */
  readonly validadoContabilidade: boolean;
}

export interface ResultadoApuracaoTributaria {
  readonly regime: RegimeTributario;
  readonly impostoSobreVendas: number;
  readonly creditosAbatidos: number;
  readonly impostoLiquidoVendas: number;
  readonly tributosSobreLucro: number;
  readonly totalTributos: number;
  readonly aliquotaEfetivaSobreFaturamento: number | null;
  readonly natureza: "estimativa_gerencial" | "apuracao_informada";
  readonly observacao: string;
}

function centavos(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Seleciona a configuração tributária vigente na data de referência (`validFrom <= data`),
 * respeitando o histórico sem alterar meses anteriores.
 */
export function selecionarConfigTributariaVigente(
  configs: readonly ConfiguracaoTributaria[],
  dataNegocio: string,
): ConfiguracaoTributaria | null {
  let melhor: ConfiguracaoTributaria | null = null;

  for (const cfg of configs) {
    if (cfg.validFrom <= dataNegocio) {
      if (melhor === null || cfg.validFrom > melhor.validFrom) {
        melhor = cfg;
      }
    }
  }

  return melhor;
}

/**
 * Calcula a apuração tributária gerencial para uma entidade fiscal conforme seu regime.
 * Se o usuário informar `impostoApuradoManual`, ele prevalece como `apuracao_informada`.
 */
export function calcularTributosEntidade(params: {
  readonly config: ConfiguracaoTributaria;
  readonly faturamentoBruto: number;
  readonly cmv?: number | null;
  readonly lucroOperacionalAntesIr?: number | null;
  readonly creditosManuais?: number | null;
  readonly impostoApuradoManual?: number | null;
}): ResultadoApuracaoTributaria {
  const { config, faturamentoBruto } = params;
  const bruto = Math.max(0, Number.isFinite(faturamentoBruto) ? faturamentoBruto : 0);

  if (params.impostoApuradoManual !== undefined && params.impostoApuradoManual !== null && Number.isFinite(params.impostoApuradoManual)) {
    const apurado = centavos(Math.max(0, params.impostoApuradoManual));
    return {
      regime: config.regime,
      impostoSobreVendas: apurado,
      creditosAbatidos: 0,
      impostoLiquidoVendas: apurado,
      tributosSobreLucro: 0,
      totalTributos: apurado,
      aliquotaEfetivaSobreFaturamento: bruto > 0 ? apurado / bruto : null,
      natureza: "apuracao_informada",
      observacao: "Valor efetivamente apurado/informado manualmente para o período.",
    };
  }

  if (config.regime === "simples_nacional") {
    const imposto = centavos(bruto * config.aliquotaEfetivaVendas);
    return {
      regime: config.regime,
      impostoSobreVendas: imposto,
      creditosAbatidos: 0,
      impostoLiquidoVendas: imposto,
      tributosSobreLucro: 0,
      totalTributos: imposto,
      aliquotaEfetivaSobreFaturamento: bruto > 0 ? imposto / bruto : null,
      natureza: "estimativa_gerencial",
      observacao: config.validadoContabilidade
        ? "Estimativa gerencial pelo DAS (Simples Nacional) com alíquota efetiva validada pela contabilidade."
        : "Estimativa gerencial pelo Simples Nacional — recomenda-se validar a faixa do RBT12 com a contabilidade.",
    };
  }

  if (config.regime === "lucro_real") {
    const debitoVendas = centavos(bruto * config.aliquotaEfetivaVendas);
    const creditoCalculado =
      params.creditosManuais !== undefined && params.creditosManuais !== null
        ? Math.max(0, params.creditosManuais)
        : params.cmv !== undefined && params.cmv !== null && (config.creditosTributariosFracao ?? 0) > 0
          ? params.cmv * (config.creditosTributariosFracao ?? 0)
          : 0;
    const creditosAbatidos = centavos(Math.min(debitoVendas, creditoCalculado));
    const impostoLiquidoVendas = centavos(debitoVendas - creditosAbatidos);

    const baseLucro =
      params.lucroOperacionalAntesIr !== undefined && params.lucroOperacionalAntesIr !== null
        ? Math.max(0, params.lucroOperacionalAntesIr)
        : 0;
    const tributosSobreLucro =
      baseLucro > 0 && (config.aliquotaSobreLucro ?? 0) > 0
        ? centavos(baseLucro * (config.aliquotaSobreLucro ?? 0))
        : 0;
    const totalTributos = centavos(impostoLiquidoVendas + tributosSobreLucro);

    return {
      regime: config.regime,
      impostoSobreVendas: debitoVendas,
      creditosAbatidos,
      impostoLiquidoVendas,
      tributosSobreLucro,
      totalTributos,
      aliquotaEfetivaSobreFaturamento: bruto > 0 ? totalTributos / bruto : null,
      natureza: "estimativa_gerencial",
      observacao:
        "Estimativa gerencial de Lucro Real (débitos sobre vendas menos créditos tributários + IRPJ/CSLL sobre lucro positivo). Sujeito à apuração contábil oficial.",
    };
  }

  // Lucro Presumido ou Configurável
  const impostoVendas = centavos(bruto * config.aliquotaEfetivaVendas);
  const tributosPresumidos =
    (config.aliquotaSobreLucro ?? 0) > 0 ? centavos(bruto * (config.aliquotaSobreLucro ?? 0)) : 0;
  const totalTributos = centavos(impostoVendas + tributosPresumidos);

  return {
    regime: config.regime,
    impostoSobreVendas: impostoVendas,
    creditosAbatidos: 0,
    impostoLiquidoVendas: impostoVendas,
    tributosSobreLucro: tributosPresumidos,
    totalTributos,
    aliquotaEfetivaSobreFaturamento: bruto > 0 ? totalTributos / bruto : null,
    natureza: "estimativa_gerencial",
    observacao:
      config.regime === "lucro_presumido"
        ? "Estimativa gerencial de Lucro Presumido (tributos sobre receita + presunção configurada). Valide as alíquotas com a contabilidade."
        : "Estimativa gerencial pela configuração tributária personalizada.",
  };
}
