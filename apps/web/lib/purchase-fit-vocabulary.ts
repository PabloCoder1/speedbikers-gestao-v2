/**
 * O vocabulário da avaliação de compra (D-721) na tela: rótulo, tom e a frase
 * de cada motivo — uma fonte só para a Reposição e a revisão do pedido.
 *
 * As frases citam os NÚMEROS que sustentam o motivo, para que "retirar" nunca
 * apareça sem o porquê. Nada aqui decide: só traduz o resultado do domínio.
 */

import type {
  MarginBand,
  MarginQuality,
  PurchaseFitResult,
  PurchaseReasonCode,
  PurchaseRecommendation,
  PurchaseSituation,
  TurnoverClass,
} from "@sb/domain";

import type { Tom } from "../components/tone";

export const SITUACAO: Record<PurchaseSituation, { rotulo: string; tom: Tom; descricao: string }> = {
  COMPRAR_AGORA: { rotulo: "Comprar agora", tom: "perigo", descricao: "em ruptura ou cobertura dentro do prazo do fornecedor" },
  COMPRAR_EM_BREVE: { rotulo: "Comprar em breve", tom: "atencao", descricao: "abaixo do ponto de pedido ou da janela de demanda" },
  ACOMPANHAR: { rotulo: "Acompanhar", tom: "ok", descricao: "o estoque cobre a janela no ritmo atual" },
  COBERTO_POR_PEDIDOS: { rotulo: "Coberto por pedidos", tom: "info", descricao: "a necessidade já está em rascunhos ou aprovados" },
  ESTOQUE_EM_EXCESSO: { rotulo: "Estoque em excesso", tom: "info", descricao: "cobertura acima do teto da política" },
  BAIXO_GIRO: { rotulo: "Baixo giro", tom: "atencao", descricao: "o estoque cobre a janela e a venda não sustenta compra nova" },
  MARGEM_INSUFICIENTE: { rotulo: "Margem insuficiente", tom: "atencao", descricao: "margem negativa ou abaixo do mínimo da organização" },
  REVISAR: { rotulo: "Revisar", tom: "atencao", descricao: "ruptura no período ou produto descontinuado" },
  PRODUTO_RECENTE: { rotulo: "Produto recente", tom: "info", descricao: "pouco tempo de venda — sem conclusão por vender pouco" },
  DADOS_INSUFICIENTES: { rotulo: "Dados insuficientes", tom: "neutro", descricao: "sem configuração, estoque real, histórico ou amostra" },
};

export const ORDEM_SITUACOES: readonly PurchaseSituation[] = [
  "COMPRAR_AGORA",
  "COMPRAR_EM_BREVE",
  "MARGEM_INSUFICIENTE",
  "REVISAR",
  "BAIXO_GIRO",
  "ESTOQUE_EM_EXCESSO",
  "COBERTO_POR_PEDIDOS",
  "PRODUTO_RECENTE",
  "ACOMPANHAR",
  "DADOS_INSUFICIENTES",
];

export const RECOMENDACAO: Record<PurchaseRecommendation, { rotulo: string; tom: Tom }> = {
  MANTER: { rotulo: "Manter", tom: "ok" },
  REDUZIR: { rotulo: "Reduzir", tom: "atencao" },
  RETIRAR: { rotulo: "Retirar do pedido", tom: "perigo" },
  REVISAR: { rotulo: "Revisar", tom: "atencao" },
};

export const GIRO: Record<TurnoverClass, string> = {
  ALTO: "Giro acima do estoque",
  BAIXO: "Estoque acima do giro",
  PARADO: "Parado (sem venda em 90 dias)",
  INDEFINIDO: "Giro indefinido",
};

export const FAIXA_MARGEM: Record<MarginBand, { rotulo: string; tom: Tom }> = {
  NEGATIVA: { rotulo: "negativa", tom: "perigo" },
  ABAIXO_DO_MINIMO: { rotulo: "abaixo do mínimo", tom: "atencao" },
  SAUDAVEL: { rotulo: "saudável", tom: "ok" },
  DESCONHECIDA: { rotulo: "não confirmada", tom: "neutro" },
};

export const QUALIDADE_MARGEM: Record<MarginQuality, string> = {
  CONFIAVEL: "confiável",
  PARCIAL: "parcial",
  ESTIMADA: "com custo atual",
  INDISPONIVEL: "indisponível",
};

/** As justificativas para manter um item que o sistema recomendou retirar ou reduzir (D-722). */
export const MOTIVOS_MANTER = [
  { valor: "COMPRA_ESTRATEGICA", rotulo: "Compra estratégica" },
  { valor: "LANCAMENTO", rotulo: "Lançamento" },
  { valor: "CAMPANHA", rotulo: "Campanha prevista" },
  { valor: "NEGOCIACAO", rotulo: "Negociação especial" },
  { valor: "PEDIDO_ESPECIFICO", rotulo: "Pedido específico" },
  { valor: "REPOSICAO_PREVENTIVA", rotulo: "Reposição preventiva" },
  { valor: "OUTRO", rotulo: "Outro motivo" },
] as const;

export type MotivoManter = (typeof MOTIVOS_MANTER)[number]["valor"];

const NUM = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const PCT = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 1 });

export function formatarMargem(margin: number | null): string {
  return margin === null ? "—" : PCT.format(margin);
}

export interface ContextoMotivo {
  readonly mediaMensal: number;
  readonly estoque: number | null;
  readonly coberturaDias: number | null;
  readonly coberturaDepoisDias: number | null;
  readonly sugestao: number | null;
  readonly recomendado: number | null;
  readonly noPedido: number | null;
  readonly margem: number | null;
  readonly margemMinima: number;
  readonly diasRuptura: number | null;
  readonly outrosPedidos: number;
  readonly tetoDias: number | null;
}

/** A frase de um motivo, com os números. */
export function fraseDoMotivo(code: PurchaseReasonCode, c: ContextoMotivo): string {
  const dias = (d: number | null): string => (d === null ? "—" : `${NUM.format(d)} dias`);

  switch (code) {
    case "RUPTURA_ATUAL":
      return "Sem estoque aproveitável agora.";
    case "COBERTURA_ABAIXO_DO_PRAZO":
      return `A cobertura (${dias(c.coberturaDias)}) acaba antes de a compra chegar.`;
    case "ABAIXO_DO_PONTO_DE_PEDIDO":
      return "Abaixo do ponto de pedido (prazo + segurança).";
    case "COBERTURA_JA_ATENDE":
      return `O estoque atual (${c.estoque === null ? "—" : NUM.format(c.estoque)} un) já cobre a janela da política: ${dias(c.coberturaDias)} no ritmo de ${NUM.format(c.mediaMensal)} un/mês.`;
    case "ACIMA_DA_SUGESTAO":
      return `No pedido: ${c.noPedido === null ? "—" : NUM.format(c.noPedido)} un; o sistema compraria ${c.recomendado === null ? "—" : NUM.format(c.recomendado)}.`;
    case "ACIMA_DO_TETO":
      return `Com o pedido, a cobertura vai a ${dias(c.coberturaDepoisDias)} — acima do teto de ${dias(c.tetoDias)}.`;
    case "DEMANDA_EM_QUEDA":
      return "A venda dos últimos 30 dias caiu mais de 25% contra os 60 anteriores.";
    case "DEMANDA_CRESCENDO":
      return "A venda dos últimos 30 dias cresceu mais de 25% contra os 60 anteriores.";
    case "SEM_VENDA_90D":
      return "Nenhuma venda em 90 dias, com estoque disponível.";
    case "MARGEM_NEGATIVA":
      return `A margem do período é ${formatarMargem(c.margem)}: cada venda tira dinheiro.`;
    case "MARGEM_ABAIXO_DO_MINIMO":
      return `Margem de ${formatarMargem(c.margem)}, abaixo do mínimo de ${formatarMargem(c.margemMinima)} — vale negociar custo ou rever preço.`;
    case "MARGEM_DESCONHECIDA":
      return "Rentabilidade não confirmada: sem venda coberta com recebido e custo conhecidos.";
    case "MARGEM_ESTIMADA":
      return "A margem usa parte das vendas ou o custo atual no lugar do histórico.";
    case "PRODUTO_RECENTE":
      return "Produto com pouco tempo de venda: ainda sem conclusão confiável.";
    case "RUPTURA_NO_PERIODO":
      return `Ficou ${c.diasRuptura === null ? "—" : String(c.diasRuptura)} dia(s) sem estoque nos últimos 30: a venda observada pode estar subestimada.`;
    case "DISPONIBILIDADE_DESCONHECIDA":
      return "Sem como saber se faltou estoque no período.";
    case "DESCONTINUADO":
      return "Produto marcado como descontinuado no ERP.";
    case "PEDIDO_SOBREPOSTO":
      return `Outros pedidos em aberto já somam ${NUM.format(c.outrosPedidos)} un deste SKU.`;
    case "ARREDONDADO_MOQ":
      return "Quantidade ajustada ao mínimo do fornecedor.";
    case "ARREDONDADO_MULTIPLO":
      return "Quantidade ajustada ao múltiplo de embalagem.";
    case "SEM_CONFIGURACAO":
      return "Sem regra de reposição (prazo e cobertura) para este SKU.";
    case "ESTOQUE_VIRTUAL":
      return "Estoque virtual (saldo sentinela): sem estoque real para comparar.";
    case "HISTORICO_INCOMPLETO":
      return "Menos de 84 dos últimos 90 dias com venda recalculada.";
    case "AMOSTRA_INSUFICIENTE":
      return "Menos de 12 unidades vendidas em 90 dias.";
  }
}

/** O contexto da frase, a partir do resultado da avaliação e dos números da linha. */
export function contextoDoMotivo(
  fit: PurchaseFitResult,
  dados: {
    readonly units30d: number;
    readonly estoque: number | null;
    readonly sugestao: number | null;
    readonly noPedido: number | null;
    readonly margem: number | null;
    readonly margemMinima: number;
    readonly diasRuptura: number | null;
    readonly outrosPedidos: number;
    readonly tetoDias: number | null;
  },
): ContextoMotivo {
  return {
    mediaMensal: dados.units30d,
    estoque: dados.estoque,
    coberturaDias: fit.coverageDays,
    coberturaDepoisDias: fit.coverageAfterOrderDays,
    sugestao: dados.sugestao,
    recomendado: fit.recommendedQuantity,
    noPedido: dados.noPedido,
    margem: dados.margem,
    margemMinima: dados.margemMinima,
    diasRuptura: dados.diasRuptura,
    outrosPedidos: dados.outrosPedidos,
    tetoDias: dados.tetoDias,
  };
}

/** Os motivos que pesam, primeiro; contexto depois. */
export function motivosOrdenados(fit: PurchaseFitResult): readonly { code: PurchaseReasonCode; weight: "atencao" | "info" }[] {
  return [...fit.reasons].sort((a, b) => (a.weight === b.weight ? 0 : a.weight === "atencao" ? -1 : 1));
}

/** Rótulo de uma recomendação vinda do banco (texto livre no tipo): o código cru se não for conhecido. */
export function rotuloRecomendacao(code: string): string {
  return code in RECOMENDACAO ? RECOMENDACAO[code as PurchaseRecommendation].rotulo : code;
}

/** Rótulo do motivo de manter vindo do banco. */
export function rotuloMotivoManter(code: string): string {
  return MOTIVOS_MANTER.find((m) => m.valor === code)?.rotulo ?? code;
}
