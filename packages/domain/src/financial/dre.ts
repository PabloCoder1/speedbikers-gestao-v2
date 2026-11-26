/**
 * Motor da DRE Gerencial, Ponto de Equilíbrio e Orçamento vs. Realizado.
 *
 * Princípios obrigatórios:
 * - Zero dupla contagem: cada dedução entra em exatamente um nível.
 * - Transparência de origem: toda linha declara se é `real`, `estimado`, `manual` ou `ausente`.
 * - Ausência de dado nunca vira zero silenciosamente: campos ausentes ficam `null` e
 *   o DRE informa explicitamente quais linhas ainda não têm fonte cadastrada.
 * - Margem do Produto permanece intocada (`(recebido - custo) / receita`); a DRE
 *   mostra separadamente Lucro Bruto, Margem de Contribuição, Lucro Operacional e
 *   Resultado Líquido Gerencial.
 */

export type OrigemDadoFinanceiro = "real" | "estimado" | "manual" | "calculado" | "ausente";

export type TipoLinhaDre = "receita" | "deducao" | "subtotal" | "resultado";

export interface EntradaDreGerencial {
  /** Faturamento bruto das vendas válidas no período (ou receita coberta quando em modo coberto). */
  readonly faturamentoBruto: number;
  /** Cancelamentos, devoluções e descontos comerciais ainda não abatidos do bruto. */
  readonly cancelamentosDevolucoes?: number | null;
  /** Impostos incidentes sobre vendas (estimado pela alíquota vigente ou apurado). */
  readonly impostosSobreVendas?: number | null;
  readonly origemImpostos?: OrigemDadoFinanceiro;
  /** Custo das mercadorias vendidas (CMV) nos pedidos cobertos. */
  readonly cmv: number | null;
  /** Comissões dos marketplaces (sale_fee × quantity). */
  readonly comissoesMarketplace: number | null;
  /** Tarifas fixas e despesas comerciais extras (não incluídas na comissão). */
  readonly tarifasComerciais?: number | null;
  /** Custos logísticos pagos pelo vendedor (frete vendedor + envio ao Full + reversa). */
  readonly custosLogisticos: number | null;
  /** Outras despesas variáveis operacionais (ex.: embalagens, insumos por venda). */
  readonly despesasVariaveis?: number | null;
  /** Investimentos em publicidade (Product Ads / Shopee Ads, proporcional à cobertura quando aplicável). */
  readonly investimentoAds: number | null;
  readonly origemAds?: OrigemDadoFinanceiro;
  /** Despesas operacionais fixas do período (aluguel, salários, energia, softwares, etc.). */
  readonly despesasFixas?: number | null;
  /** Receitas financeiras líquidas de despesas financeiras (+ receita, - despesa). */
  readonly resultadoFinanceiro?: number | null;
  /** Tributos sobre o lucro/resultado (ex.: IRPJ/CSLL no Lucro Real), quando aplicáveis. */
  readonly tributosSobreResultado?: number | null;
  /** Cobertura da receita (0..1) quando CMV/frete só existem no subconjunto coberto. */
  readonly coberturaReceita?: number | null;
}

export interface LinhaDre {
  readonly id: string;
  readonly rotulo: string;
  readonly tipo: TipoLinhaDre;
  /** Valor em reais (positivo para receitas/subtotais positivos, negativo para deduções/prejuízos). `null` se ausente. */
  readonly valor: number | null;
  /** Participação sobre o faturamento bruto (fração). `null` se valor ausente ou bruto <= 0. */
  readonly percentualSobreBruto: number | null;
  readonly origem: OrigemDadoFinanceiro;
  readonly explicacao: string;
  /** Indica se a linha é um destaque executivo na DRE. */
  readonly destaque?: boolean;
}

export interface PontoDeEquilibrio {
  /** Faturamento mínimo necessário para cobrir as despesas fixas. `null` quando inalcançável ou sem dados. */
  readonly faturamentoEquilibrio: number | null;
  /** Margem de contribuição em fração usada no denominador. */
  readonly margemContribuicaoFracao: number | null;
  /** Despesas fixas consideradas no numerador. */
  readonly despesasFixas: number | null;
  /** Folga ou déficit em reais: faturamento atual − faturamento de equilíbrio. */
  readonly folgaEmReais: number | null;
  /** Margem de segurança em fração: (faturamento − equilíbrio) ÷ faturamento. */
  readonly margemSegurancaFracao: number | null;
  /** Status estrutural do ponto de equilíbrio. */
  readonly status: "alcancavel" | "margem_nao_positiva" | "sem_despesas_fixas" | "dados_insuficientes";
  readonly explicacao: string;
}

export interface DreGerencial {
  readonly linhas: readonly LinhaDre[];
  readonly faturamentoBruto: number;
  readonly receitaAposDeducoes: number;
  readonly receitaLiquida: number | null;
  readonly lucroBruto: number | null;
  readonly margemContribuicaoValor: number | null;
  readonly margemContribuicaoFracao: number | null;
  readonly resultadoOperacional: number | null;
  readonly resultadoLiquidoGerencial: number | null;
  readonly margemLiquidaFinal: number | null;
  readonly pontoDeEquilibrio: PontoDeEquilibrio;
  /** Lista explícita de lacunas (ex.: "despesas fixas não cadastradas"). */
  readonly lacunas: readonly string[];
}

function centavos(v: number): number {
  return Math.round(v * 100) / 100;
}

function pct(valor: number | null, base: number): number | null {
  if (valor === null || !Number.isFinite(base) || base <= 0) return null;
  return valor / base;
}

function finito(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Calcula o Ponto de Equilíbrio contábil/gerencial:
 *   PE = Despesas Fixas ÷ Margem de Contribuição (%)
 *
 * Trata explicitamente:
 * - Margem de contribuição <= 0 (inalcançável nas condições atuais);
 * - Despesas fixas não cadastradas (`null`) ou zero;
 * - Dados insuficientes.
 */
export function calcularPontoDeEquilibrio(params: {
  readonly despesasFixas: number | null;
  readonly margemContribuicaoFracao: number | null;
  readonly faturamentoAtual: number;
}): PontoDeEquilibrio {
  const { despesasFixas, margemContribuicaoFracao, faturamentoAtual } = params;

  if (!finito(despesasFixas)) {
    return {
      faturamentoEquilibrio: null,
      margemContribuicaoFracao,
      despesasFixas: null,
      folgaEmReais: null,
      margemSegurancaFracao: null,
      status: "sem_despesas_fixas",
      explicacao:
        "Cadastre as despesas operacionais fixas em Custos e Fiscal para calcular quanto a empresa precisa faturar para empatar.",
    };
  }

  if (despesasFixas < 0) {
    return {
      faturamentoEquilibrio: null,
      margemContribuicaoFracao,
      despesasFixas,
      folgaEmReais: null,
      margemSegurancaFracao: null,
      status: "dados_insuficientes",
      explicacao: "Despesas fixas inválidas (valor negativo).",
    };
  }

  if (!finito(margemContribuicaoFracao)) {
    return {
      faturamentoEquilibrio: null,
      margemContribuicaoFracao: null,
      despesasFixas,
      folgaEmReais: null,
      margemSegurancaFracao: null,
      status: "dados_insuficientes",
      explicacao:
        "A margem de contribuição ainda não está fechada no período (verifique alíquota de imposto, custo e cobertura de Ads).",
    };
  }

  if (margemContribuicaoFracao <= 0) {
    return {
      faturamentoEquilibrio: null,
      margemContribuicaoFracao,
      despesasFixas,
      folgaEmReais: null,
      margemSegurancaFracao: null,
      status: "margem_nao_positiva",
      explicacao:
        "Margem de contribuição nula ou negativa: nas condições atuais cada venda adicional não gera folga para cobrir despesas fixas. É preciso revisar preços, custos, frete ou Ads antes de buscar volume.",
    };
  }

  const faturamentoEquilibrio = centavos(despesasFixas / margemContribuicaoFracao);
  const folgaEmReais = Number.isFinite(faturamentoAtual) ? centavos(faturamentoAtual - faturamentoEquilibrio) : null;
  const margemSegurancaFracao =
    folgaEmReais !== null && faturamentoAtual > 0 ? folgaEmReais / faturamentoAtual : null;

  return {
    faturamentoEquilibrio,
    margemContribuicaoFracao,
    despesasFixas,
    folgaEmReais,
    margemSegurancaFracao,
    status: "alcancavel",
    explicacao:
      folgaEmReais !== null && folgaEmReais >= 0
        ? "Operação acima do ponto de equilíbrio no período analisado."
        : "Faturamento atual ainda abaixo do necessário para cobrir integralmente as despesas fixas do período.",
  };
}

/**
 * Monta a DRE Gerencial completa do período, sem dupla contagem e sinalizando
 * cada lacuna de dado explicitamente.
 */
export function montarDreGerencial(entrada: EntradaDreGerencial): DreGerencial {
  const bruto = centavos(Math.max(0, entrada.faturamentoBruto));
  const lacunas: string[] = [];

  const cancelamentos = finito(entrada.cancelamentosDevolucoes) ? centavos(Math.max(0, entrada.cancelamentosDevolucoes)) : null;
  const receitaAposDeducoes = centavos(bruto - (cancelamentos ?? 0));

  const impostos = finito(entrada.impostosSobreVendas) ? centavos(Math.max(0, entrada.impostosSobreVendas)) : null;
  if (impostos === null) {
    lacunas.push("Impostos sobre vendas ausentes (cadastre a alíquota em Metas e imposto ou Custos e Fiscal).");
  }

  const receitaLiquida = impostos === null ? null : centavos(receitaAposDeducoes - impostos);

  const cmv = finito(entrada.cmv) ? centavos(Math.max(0, entrada.cmv)) : null;
  if (cmv === null) {
    lacunas.push("CMV (custo das mercadorias vendidas) indisponível no período.");
  }

  const lucroBruto = receitaLiquida !== null && cmv !== null ? centavos(receitaLiquida - cmv) : null;

  const comissoes = finito(entrada.comissoesMarketplace) ? centavos(Math.max(0, entrada.comissoesMarketplace)) : null;
  const tarifas = finito(entrada.tarifasComerciais) ? centavos(Math.max(0, entrada.tarifasComerciais)) : null;
  const logistica = finito(entrada.custosLogisticos) ? centavos(Math.max(0, entrada.custosLogisticos)) : null;
  const variaveis = finito(entrada.despesasVariaveis) ? centavos(Math.max(0, entrada.despesasVariaveis)) : null;
  const ads = finito(entrada.investimentoAds) ? centavos(Math.max(0, entrada.investimentoAds)) : null;

  if (logistica === null) {
    lacunas.push("Custos logísticos (frete do vendedor) indisponíveis no período.");
  }
  if (ads === null) {
    lacunas.push("Investimento em publicidade incompleto para todos os dias do período.");
  }

  const margemContribuicaoValor =
    lucroBruto !== null && comissoes !== null && logistica !== null && ads !== null
      ? centavos(lucroBruto - comissoes - (tarifas ?? 0) - logistica - (variaveis ?? 0) - ads)
      : null;

  const margemContribuicaoFracao = pct(margemContribuicaoValor, bruto);

  const despesasFixas = finito(entrada.despesasFixas) ? centavos(Math.max(0, entrada.despesasFixas)) : null;
  if (despesasFixas === null) {
    lacunas.push("Despesas operacionais fixas não cadastradas para o período (resultado operacional e lucro líquido final pendentes).");
  }

  const resultadoOperacional =
    margemContribuicaoValor !== null && despesasFixas !== null
      ? centavos(margemContribuicaoValor - despesasFixas)
      : null;

  const resultadoFinanceiro = finito(entrada.resultadoFinanceiro) ? centavos(entrada.resultadoFinanceiro) : null;
  const tributosResultado = finito(entrada.tributosSobreResultado) ? centavos(Math.max(0, entrada.tributosSobreResultado)) : null;

  const resultadoLiquidoGerencial =
    resultadoOperacional !== null
      ? centavos(resultadoOperacional + (resultadoFinanceiro ?? 0) - (tributosResultado ?? 0))
      : null;

  const margemLiquidaFinal = pct(resultadoLiquidoGerencial, bruto);

  const linhas: LinhaDre[] = [
    {
      id: "faturamento_bruto",
      rotulo: "Faturamento bruto",
      tipo: "receita",
      valor: bruto,
      percentualSobreBruto: bruto > 0 ? 1 : null,
      origem: "real",
      explicacao:
        entrada.coberturaReceita !== undefined && entrada.coberturaReceita !== null && entrada.coberturaReceita < 0.999
          ? "Receita bruta dos pedidos cobertos (mesma base de CMV, comissão e frete para evitar distorção de cobertura)."
          : "Receita bruta total das vendas válidas no período.",
      destaque: true,
    },
    {
      id: "cancelamentos_devolucoes",
      rotulo: "(-) Cancelamentos, devoluções e abatimentos",
      tipo: "deducao",
      valor: cancelamentos === null ? null : -cancelamentos,
      percentualSobreBruto: pct(cancelamentos === null ? null : -cancelamentos, bruto),
      origem: cancelamentos === null ? "ausente" : "real",
      explicacao: "Devoluções financeiras e abatimentos ainda não descontados no valor bruto.",
    },
    {
      id: "impostos_vendas",
      rotulo: "(-) Impostos sobre vendas",
      tipo: "deducao",
      valor: impostos === null ? null : -impostos,
      percentualSobreBruto: pct(impostos === null ? null : -impostos, bruto),
      origem: impostos === null ? "ausente" : (entrada.origemImpostos ?? "estimado"),
      explicacao: "Estimativa gerencial pela alíquota vigente no dia de cada venda ou apuração fiscal cadastrada.",
    },
    {
      id: "receita_liquida",
      rotulo: "(=) Receita líquida gerencial",
      tipo: "subtotal",
      valor: receitaLiquida,
      percentualSobreBruto: pct(receitaLiquida, bruto),
      origem: receitaLiquida === null ? "ausente" : "calculado",
      explicacao: "Faturamento após cancelamentos/devoluções e impostos incidentes sobre vendas.",
    },
    {
      id: "cmv",
      rotulo: "(-) Custo das mercadorias vendidas (CMV)",
      tipo: "deducao",
      valor: cmv === null ? null : -cmv,
      percentualSobreBruto: pct(cmv === null ? null : -cmv, bruto),
      origem: cmv === null ? "ausente" : "real",
      explicacao: "Custo histórico do SKU na data da venda (ou soma dos componentes em kits).",
    },
    {
      id: "lucro_bruto",
      rotulo: "(=) Lucro bruto",
      tipo: "subtotal",
      valor: lucroBruto,
      percentualSobreBruto: pct(lucroBruto, bruto),
      origem: lucroBruto === null ? "ausente" : "calculado",
      explicacao: "Receita líquida menos o custo das mercadorias vendidas.",
    },
    {
      id: "comissoes",
      rotulo: "(-) Comissões dos marketplaces",
      tipo: "deducao",
      valor: comissoes === null ? null : -comissoes,
      percentualSobreBruto: pct(comissoes === null ? null : -comissoes, bruto),
      origem: comissoes === null ? "ausente" : "real",
      explicacao: "Comissões de venda cobradas pelo marketplace por unidade vendida.",
    },
    {
      id: "custos_logisticos",
      rotulo: "(-) Custos logísticos (frete vendedor)",
      tipo: "deducao",
      valor: logistica === null ? null : -logistica,
      percentualSobreBruto: pct(logistica === null ? null : -logistica, bruto),
      origem: logistica === null ? "ausente" : "real",
      explicacao: "Frete pago pelo vendedor nos pedidos cobertos (sem dupla contagem com repasse).",
    },
    ...(tarifas !== null && tarifas > 0
      ? [
          {
            id: "tarifas_comerciais",
            rotulo: "(-) Tarifas e despesas comerciais",
            tipo: "deducao" as const,
            valor: -tarifas,
            percentualSobreBruto: pct(-tarifas, bruto),
            origem: "manual" as const,
            explicacao: "Tarifas fixas e custos comerciais extras fora da comissão principal.",
          },
        ]
      : []),
    ...(variaveis !== null && variaveis > 0
      ? [
          {
            id: "despesas_variaveis",
            rotulo: "(-) Despesas variáveis operacionais",
            tipo: "deducao" as const,
            valor: -variaveis,
            percentualSobreBruto: pct(-variaveis, bruto),
            origem: "manual" as const,
            explicacao: "Embalagens, insumos e outras despesas variáveis lançadas para o período.",
          },
        ]
      : []),
    {
      id: "investimento_ads",
      rotulo: "(-) Investimento em publicidade (Ads)",
      tipo: "deducao",
      valor: ads === null ? null : -ads,
      percentualSobreBruto: pct(ads === null ? null : -ads, bruto),
      origem: ads === null ? "ausente" : (entrada.origemAds ?? "real"),
      explicacao: "Investimento em Product Ads / Shopee Ads proporcional à cobertura do período.",
    },
    {
      id: "margem_contribuicao",
      rotulo: "(=) Margem de contribuição",
      tipo: "subtotal",
      valor: margemContribuicaoValor,
      percentualSobreBruto: margemContribuicaoFracao,
      origem: margemContribuicaoValor === null ? "ausente" : "calculado",
      explicacao: "Quanto sobra das vendas para pagar as despesas fixas da empresa e gerar lucro.",
      destaque: true,
    },
    {
      id: "despesas_fixas",
      rotulo: "(-) Despesas operacionais fixas",
      tipo: "deducao",
      valor: despesasFixas === null ? null : -despesasFixas,
      percentualSobreBruto: pct(despesasFixas === null ? null : -despesasFixas, bruto),
      origem: despesasFixas === null ? "ausente" : "manual",
      explicacao: "Aluguel, salários, energia, internet, softwares, contabilidade e demais custos fixos do período.",
    },
    {
      id: "resultado_operacional",
      rotulo: "(=) Resultado operacional (EBIT gerencial)",
      tipo: "subtotal",
      valor: resultadoOperacional,
      percentualSobreBruto: pct(resultadoOperacional, bruto),
      origem: resultadoOperacional === null ? "ausente" : "calculado",
      explicacao: "Margem de contribuição menos as despesas operacionais fixas.",
    },
    ...(resultadoFinanceiro !== null && resultadoFinanceiro !== 0
      ? [
          {
            id: "resultado_financeiro",
            rotulo: "(+/-) Receitas e despesas financeiras",
            tipo: "deducao" as const,
            valor: resultadoFinanceiro,
            percentualSobreBruto: pct(resultadoFinanceiro, bruto),
            origem: "manual" as const,
            explicacao: "Tarifas bancárias, juros, rendimentos e despesas financeiras líquidas.",
          },
        ]
      : []),
    ...(tributosResultado !== null && tributosResultado > 0
      ? [
          {
            id: "tributos_resultado",
            rotulo: "(-) Tributos sobre o resultado",
            tipo: "deducao" as const,
            valor: -tributosResultado,
            percentualSobreBruto: pct(-tributosResultado, bruto),
            origem: "estimado" as const,
            explicacao: "IRPJ / CSLL ou tributos sobre o lucro quando aplicáveis ao regime tributário.",
          },
        ]
      : []),
    {
      id: "resultado_liquido_gerencial",
      rotulo: "(=) Resultado líquido gerencial",
      tipo: "resultado",
      valor: resultadoLiquidoGerencial,
      percentualSobreBruto: margemLiquidaFinal,
      origem: resultadoLiquidoGerencial === null ? "ausente" : "calculado",
      explicacao: "Lucro líquido final estimado após todos os custos variáveis, fixos, financeiros e tributos.",
      destaque: true,
    },
  ];

  const pontoDeEquilibrio = calcularPontoDeEquilibrio({
    despesasFixas,
    margemContribuicaoFracao,
    faturamentoAtual: bruto,
  });

  return {
    linhas,
    faturamentoBruto: bruto,
    receitaAposDeducoes,
    receitaLiquida,
    lucroBruto,
    margemContribuicaoValor,
    margemContribuicaoFracao,
    resultadoOperacional,
    resultadoLiquidoGerencial,
    margemLiquidaFinal,
    pontoDeEquilibrio,
    lacunas,
  };
}
