/**
 * Regra obrigatória de cálculo de Margem do Produto — SpeedBikers Gestão.
 *
 * Fórmula oficial:
 *   Margem do Produto (%) = (Valor Líquido Recebido − Custo do Produto) × 100 ÷ Valor de Venda
 *
 * Regras invariantes:
 * - Nunca confundir margem com markup.
 * - Nunca calcular média simples de margens individuais para consolidar:
 *   a margem consolidada é sempre (Σ recebido − Σ custo) ÷ Σ valor de venda.
 * - Custo desconhecido (`null`, `undefined`, `NaN` ou `<= 0` quando não permitido)
 *   nunca vira zero silenciosamente: o item sai do subconjunto coberto e é contado à parte.
 * - Vendas canceladas ou com valor de venda <= 0 retornam `null` (indefinido), nunca 0%.
 */

export interface ItemMargemProduto {
  /** Valor bruto da venda (antes das deduções financeiras consideradas no recebimento). */
  readonly valorVenda: number | null;
  /** Valor líquido recebido após deduções do canal (comissão, frete do vendedor, etc., sem dupla contagem). */
  readonly valorLiquidoRecebido: number | null;
  /** Custo total da mercadoria vendida (já multiplicado pela quantidade ou soma dos componentes do kit). */
  readonly custoProduto: number | null;
  /** Quantidade vendida (informativa; deve ser > 0 para venda válida). */
  readonly quantidade?: number;
  /** Vendas canceladas não entram na margem consolidada. */
  readonly cancelada?: boolean;
}

export interface ResultadoMargemProduto {
  /** Valor líquido recebido − custo do produto (em reais, arredondado em centavos). `null` se não coberto. */
  readonly resultado: number | null;
  /** Fração (ex.: 0.30 para 30%). `null` quando indefinida. */
  readonly margemFracao: number | null;
  /** Percentual pronto (ex.: 30 para 30%). `null` quando indefinida. */
  readonly margemPercentual: number | null;
  /** Indica se o item pôde ser calculado com dados completos. */
  readonly coberto: boolean;
  /** Motivo explícito quando `coberto === false`. */
  readonly motivoIndefinido: string | null;
}

export interface ConsolidadoMargemProdutos {
  readonly valorVendaTotal: number;
  readonly valorVendaCoberto: number;
  readonly valorLiquidoRecebidoCoberto: number;
  readonly custoProdutoCoberto: number;
  readonly resultadoTotal: number | null;
  /** Margem ponderada pelo faturamento coberto (fração, ex.: 0.30 = 30%). Nunca média simples. */
  readonly margemFracao: number | null;
  /** Margem ponderada em percentual (ex.: 30 = 30%). */
  readonly margemPercentual: number | null;
  readonly itensValidos: number;
  readonly itensCobertos: number;
  readonly itensCancelados: number;
  readonly itensSemCusto: number;
  readonly itensSemRecebido: number;
  /** Fração da receita coberta sobre a receita total válida (`0..1`). `null` se sem vendas válidas. */
  readonly coberturaReceita: number | null;
}

function centavos(valor: number): number {
  return Math.round(valor * 100) / 100;
}

function finito(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Calcula a margem oficial de um produto/venda individual.
 *
 * Exemplo de validação:
 *   valorVenda = 100, valorLiquidoRecebido = 80, custoProduto = 50
 *   → resultado = 30, margemFracao = 0.3, margemPercentual = 30
 */
export function calcularMargemProduto(item: ItemMargemProduto): ResultadoMargemProduto {
  if (item.cancelada === true) {
    return {
      resultado: null,
      margemFracao: null,
      margemPercentual: null,
      coberto: false,
      motivoIndefinido: "venda cancelada",
    };
  }

  if (item.quantidade !== undefined && (!Number.isFinite(item.quantidade) || item.quantidade <= 0)) {
    return {
      resultado: null,
      margemFracao: null,
      margemPercentual: null,
      coberto: false,
      motivoIndefinido: "quantidade inválida",
    };
  }

  if (!finito(item.valorVenda) || item.valorVenda <= 0) {
    return {
      resultado: null,
      margemFracao: null,
      margemPercentual: null,
      coberto: false,
      motivoIndefinido: "valor de venda ausente ou zero",
    };
  }

  if (!finito(item.valorLiquidoRecebido)) {
    return {
      resultado: null,
      margemFracao: null,
      margemPercentual: null,
      coberto: false,
      motivoIndefinido: "valor líquido recebido desconhecido",
    };
  }

  // Custo desconhecido ou zero não é assumido como zero silenciosamente.
  if (!finito(item.custoProduto) || item.custoProduto <= 0) {
    return {
      resultado: null,
      margemFracao: null,
      margemPercentual: null,
      coberto: false,
      motivoIndefinido: "custo do produto desconhecido",
    };
  }

  const resultado = centavos(item.valorLiquidoRecebido - item.custoProduto);
  const margemFracao = resultado / item.valorVenda;
  const margemPercentual = Math.round(margemFracao * 10000) / 100;

  return {
    resultado,
    margemFracao,
    margemPercentual,
    coberto: true,
    motivoIndefinido: null,
  };
}

/**
 * Consolida a margem do produto sobre uma lista de vendas/SKUs usando
 * soma monetária ponderada pelo faturamento coberto (jamais média simples).
 */
export function consolidarMargemProdutos(itens: readonly ItemMargemProduto[]): ConsolidadoMargemProdutos {
  let valorVendaTotal = 0;
  let valorVendaCoberto = 0;
  let valorLiquidoRecebidoCoberto = 0;
  let custoProdutoCoberto = 0;
  let itensValidos = 0;
  let itensCobertos = 0;
  let itensCancelados = 0;
  let itensSemCusto = 0;
  let itensSemRecebido = 0;

  for (const item of itens) {
    if (item.cancelada === true) {
      itensCancelados += 1;
      continue;
    }

    if (!finito(item.valorVenda) || item.valorVenda <= 0) {
      continue;
    }

    if (item.quantidade !== undefined && (!Number.isFinite(item.quantidade) || item.quantidade <= 0)) {
      continue;
    }

    itensValidos += 1;
    valorVendaTotal += item.valorVenda;

    const semRecebido = !finito(item.valorLiquidoRecebido);
    const semCusto = !finito(item.custoProduto) || item.custoProduto <= 0;

    if (semRecebido) itensSemRecebido += 1;
    if (semCusto) itensSemCusto += 1;

    if (!semRecebido && !semCusto) {
      itensCobertos += 1;
      valorVendaCoberto += item.valorVenda;
      valorLiquidoRecebidoCoberto += item.valorLiquidoRecebido;
      custoProdutoCoberto += item.custoProduto;
    }
  }

  valorVendaTotal = centavos(valorVendaTotal);
  valorVendaCoberto = centavos(valorVendaCoberto);
  valorLiquidoRecebidoCoberto = centavos(valorLiquidoRecebidoCoberto);
  custoProdutoCoberto = centavos(custoProdutoCoberto);

  if (itensCobertos === 0 || valorVendaCoberto <= 0) {
    return {
      valorVendaTotal,
      valorVendaCoberto: 0,
      valorLiquidoRecebidoCoberto: 0,
      custoProdutoCoberto: 0,
      resultadoTotal: null,
      margemFracao: null,
      margemPercentual: null,
      itensValidos,
      itensCobertos: 0,
      itensCancelados,
      itensSemCusto,
      itensSemRecebido,
      coberturaReceita: valorVendaTotal > 0 ? 0 : null,
    };
  }

  const resultadoTotal = centavos(valorLiquidoRecebidoCoberto - custoProdutoCoberto);
  const margemFracao = resultadoTotal / valorVendaCoberto;
  const margemPercentual = Math.round(margemFracao * 10000) / 100;

  return {
    valorVendaTotal,
    valorVendaCoberto,
    valorLiquidoRecebidoCoberto,
    custoProdutoCoberto,
    resultadoTotal,
    margemFracao,
    margemPercentual,
    itensValidos,
    itensCobertos,
    itensCancelados,
    itensSemCusto,
    itensSemRecebido,
    coberturaReceita: valorVendaTotal > 0 ? valorVendaCoberto / valorVendaTotal : null,
  };
}

/**
 * Calcula o preço de venda necessário para atingir uma margem desejada,
 * dada a comissão (fração), imposto (fração), frete fixo e custo do produto.
 *
 * Como `recebido = preco * (1 - comissao - imposto) - frete - tarifaFixa`,
 * temos: `margem = (recebido - custo) / preco`
 *   => `preco = (custo + frete + tarifaFixa) / (1 - comissao - imposto - margemDesejada)`
 *
 * Retorna `null` se o denominador for <= 0 (margem impossível sob essas taxas).
 */
export function calcularPrecoParaMargemDesejada(params: {
  readonly custo: number;
  readonly freteFixo: number;
  readonly tarifaFixa?: number;
  readonly comissaoFracao: number;
  readonly impostoFracao?: number;
  readonly margemDesejadaFracao: number;
}): number | null {
  const tarifaFixa = params.tarifaFixa ?? 0;
  const imposto = params.impostoFracao ?? 0;

  if (
    !Number.isFinite(params.custo) ||
    params.custo <= 0 ||
    !Number.isFinite(params.freteFixo) ||
    params.freteFixo < 0 ||
    !Number.isFinite(tarifaFixa) ||
    tarifaFixa < 0 ||
    !Number.isFinite(params.comissaoFracao) ||
    params.comissaoFracao < 0 ||
    !Number.isFinite(imposto) ||
    imposto < 0 ||
    !Number.isFinite(params.margemDesejadaFracao)
  ) {
    return null;
  }

  const denominador = 1 - params.comissaoFracao - imposto - params.margemDesejadaFracao;

  if (denominador <= 0.0001) return null;

  return centavos((params.custo + params.freteFixo + tarifaFixa) / denominador);
}
