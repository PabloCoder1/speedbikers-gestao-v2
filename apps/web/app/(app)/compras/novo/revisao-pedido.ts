/**
 * A revisão do pedido antes de confirmar (D-722) — a parte pura, testável.
 *
 * Cada item recebe uma CLASSE de revisão a partir da avaliação de compra
 * (D-721); o comprador decide manter, reduzir ou retirar; e esta peça monta o
 * que vai para o banco: as colunas de revisão de cada item e o histórico de
 * decisões, INCLUSIVE dos itens retirados (que deixam de existir no pedido).
 *
 * Nada aqui retira item sozinho: as funções só aplicam o que o comprador
 * escolheu. "Valor retirado" é redução do pedido PLANEJADO, nunca economia
 * realizada — a tela diz isso ao lado do número.
 */

import type { PurchaseRecommendation } from "@sb/domain";

import type { AvaliacaoSku } from "../../../../lib/purchase-analysis";
import type { MotivoManter } from "../../../../lib/purchase-fit-vocabulary";

export type ClasseRevisao = "COMPRAR" | "AVALIAR" | "RETIRAR" | "MARGEM" | "SEM_DADOS";

export const CLASSE_REVISAO: Record<ClasseRevisao, string> = {
  COMPRAR: "Recomendados para compra",
  AVALIAR: "Precisam de avaliação",
  RETIRAR: "O sistema recomenda retirar",
  MARGEM: "Margem insuficiente",
  SEM_DADOS: "Sem dados confiáveis",
};

export const ORDEM_CLASSES: readonly ClasseRevisao[] = ["RETIRAR", "AVALIAR", "MARGEM", "SEM_DADOS", "COMPRAR"];

export function classificarParaRevisao(avaliacao: AvaliacaoSku | null): ClasseRevisao {
  const fit = avaliacao?.fit ?? null;

  if (fit === null) return "SEM_DADOS";
  if (fit.recommendation === "RETIRAR") return "RETIRAR";
  if (fit.recommendation === "REDUZIR" || fit.recommendation === "REVISAR") return "AVALIAR";
  if (fit.marginBand === "NEGATIVA" || fit.marginBand === "ABAIXO_DO_MINIMO") return "MARGEM";
  if (fit.recommendation === null || fit.situation === "DADOS_INSUFICIENTES") return "SEM_DADOS";

  return "COMPRAR";
}

export type DecisaoComprador = "MANTER" | "REDUZIR" | "RETIRAR";

export interface DecisaoItem {
  readonly decision: DecisaoComprador;
  readonly reason: MotivoManter | null;
  readonly note: string;
  /** A quantidade ANTES da decisão — o histórico guarda o de/para. */
  readonly quantityBefore: number;
}

/** O que a revisão precisa de cada linha do formulário. */
export interface LinhaRevisao {
  readonly key: string;
  readonly skuId: string | null;
  readonly sku: string;
  readonly quantidade: number | null;
  readonly custo: number | null;
  readonly avaliacao: AvaliacaoSku | null;
}

/** Um item retirado pela revisão: sai do pedido, fica no histórico. */
export interface ItemRetirado {
  readonly key: string;
  readonly skuId: string | null;
  readonly sku: string;
  readonly titulo: string | null;
  readonly quantidade: number;
  readonly custo: number | null;
  readonly recommendation: PurchaseRecommendation | null;
  readonly recommendedQuantity: number | null;
  readonly reason: MotivoManter | null;
  readonly note: string;
}

export interface ImpactoRevisao {
  readonly itens: number;
  readonly unidades: number;
  /** Nulo se nenhum item tem custo; `valorParcial` diz se faltou custo em algum. */
  readonly valor: number | null;
  readonly valorParcial: boolean;
  readonly retirados: number;
  readonly unidadesRetiradas: number;
  /** Redução do pedido planejado (nunca "economia"); nula se nenhum retirado tem custo. */
  readonly valorRetirado: number | null;
  readonly reduzidos: number;
  readonly unidadesReduzidas: number;
  readonly emRisco: number;
  readonly prioridade: number;
}

function arred(v: number): number {
  return Math.round(v * 100) / 100;
}

export function impactoDaRevisao(
  linhas: readonly LinhaRevisao[],
  retirados: readonly ItemRetirado[],
  decisoes: ReadonlyMap<string, DecisaoItem>,
): ImpactoRevisao {
  let unidades = 0;
  let valor: number | null = null;
  let semCusto = 0;
  let emRisco = 0;
  let prioridade = 0;
  let reduzidos = 0;
  let unidadesReduzidas = 0;

  for (const l of linhas) {
    if (l.quantidade === null) continue;

    unidades += l.quantidade;

    if (l.custo === null) semCusto += 1;
    else valor = (valor ?? 0) + l.quantidade * l.custo;

    const classe = classificarParaRevisao(l.avaliacao);

    if (classe === "RETIRAR" || classe === "AVALIAR" || classe === "MARGEM") emRisco += 1;

    const situacao = l.avaliacao?.fit?.situation;

    if (situacao === "COMPRAR_AGORA") prioridade += 1;

    const d = decisoes.get(l.key);

    if (d?.decision === "REDUZIR" && d.quantityBefore > l.quantidade) {
      reduzidos += 1;
      unidadesReduzidas += d.quantityBefore - l.quantidade;
    }
  }

  let valorRetirado: number | null = null;

  for (const r of retirados) {
    if (r.custo !== null) valorRetirado = (valorRetirado ?? 0) + r.quantidade * r.custo;
  }

  return {
    itens: linhas.filter((l) => l.quantidade !== null).length,
    unidades,
    valor: valor === null ? null : arred(valor),
    valorParcial: valor !== null && semCusto > 0,
    retirados: retirados.length,
    unidadesRetiradas: retirados.reduce((s, r) => s + r.quantidade, 0),
    valorRetirado: valorRetirado === null ? null : arred(valorRetirado),
    reduzidos,
    unidadesReduzidas,
    emRisco,
    prioridade,
  };
}

/** As colunas de revisão de um item que vai para o banco. */
export interface CamposRevisaoItem {
  readonly recommendedQuantity: number | null;
  readonly reviewRecommendation: PurchaseRecommendation | null;
  readonly reviewDecision: "MANTER" | "REDUZIR" | null;
  readonly reviewReason: MotivoManter | null;
  readonly reviewNote: string | null;
}

export function camposDoItem(linha: LinhaRevisao, decisao: DecisaoItem | undefined): CamposRevisaoItem {
  const fit = linha.avaliacao?.fit ?? null;

  return {
    recommendedQuantity: fit?.recommendedQuantity ?? null,
    reviewRecommendation: fit?.recommendation ?? null,
    reviewDecision: decisao === undefined || decisao.decision === "RETIRAR" ? null : decisao.decision,
    reviewReason: decisao?.decision === "MANTER" ? decisao.reason : null,
    reviewNote: decisao !== undefined && decisao.note.trim() !== "" ? decisao.note.trim() : null,
  };
}

/** Uma decisão do histórico (`purchase_order_review_decisions`), na forma que a RPC lê. */
export interface DecisaoRegistro {
  readonly skuId: string | null;
  readonly skuSnapshot: string;
  readonly recommendation: PurchaseRecommendation;
  readonly decision: DecisaoComprador;
  readonly quantityBefore: number;
  readonly quantityAfter: number;
  readonly recommendedQuantity: number | null;
  readonly reason: MotivoManter | null;
  readonly note: string | null;
  readonly unitCost: number | null;
}

/**
 * O histórico desta gravação: uma linha por decisão TOMADA diante de uma
 * recomendação que não era "manter" — e uma por item retirado. Manter o que o
 * sistema já mandava manter não é decisão a registrar.
 */
export function registrosDeDecisao(
  linhas: readonly LinhaRevisao[],
  retirados: readonly ItemRetirado[],
  decisoes: ReadonlyMap<string, DecisaoItem>,
): DecisaoRegistro[] {
  const out: DecisaoRegistro[] = [];

  for (const l of linhas) {
    const d = decisoes.get(l.key);
    const rec = l.avaliacao?.fit?.recommendation ?? null;

    if (d === undefined || rec === null || rec === "MANTER" || l.quantidade === null) continue;

    out.push({
      skuId: l.skuId,
      skuSnapshot: l.sku,
      recommendation: rec,
      decision: d.decision === "REDUZIR" && l.quantidade >= d.quantityBefore ? "MANTER" : d.decision,
      quantityBefore: d.quantityBefore,
      quantityAfter: l.quantidade,
      recommendedQuantity: l.avaliacao?.fit?.recommendedQuantity ?? null,
      reason: d.decision === "MANTER" ? d.reason : null,
      note: d.note.trim() === "" ? null : d.note.trim(),
      unitCost: l.custo,
    });
  }

  for (const r of retirados) {
    out.push({
      skuId: r.skuId,
      skuSnapshot: r.sku,
      recommendation: r.recommendation ?? "RETIRAR",
      decision: "RETIRAR",
      quantityBefore: r.quantidade,
      quantityAfter: 0,
      recommendedQuantity: r.recommendedQuantity,
      reason: null,
      note: r.note.trim() === "" ? null : r.note.trim(),
      unitCost: r.custo,
    });
  }

  return out;
}

/**
 * A quantidade para "reduzir": a recomendada, quando ela é positiva e menor que
 * a do pedido. Zero não é redução — é retirar, e tem botão próprio.
 */
export function quantidadeParaReduzir(linha: LinhaRevisao): number | null {
  const alvo = linha.avaliacao?.fit?.recommendedQuantity ?? null;

  if (alvo === null || alvo <= 0 || linha.quantidade === null || alvo >= linha.quantidade) return null;

  return alvo;
}

/** As linhas que o lote "aplicar recomendações" alcança, e o que faz em cada uma. */
export function planoDoLote(linhas: readonly LinhaRevisao[]): { key: string; acao: "REDUZIR" | "RETIRAR"; quantidade: number }[] {
  const plano: { key: string; acao: "REDUZIR" | "RETIRAR"; quantidade: number }[] = [];

  for (const l of linhas) {
    const rec = l.avaliacao?.fit?.recommendation ?? null;

    if (rec === "RETIRAR") plano.push({ key: l.key, acao: "RETIRAR", quantidade: 0 });

    if (rec === "REDUZIR") {
      const q = quantidadeParaReduzir(l);

      if (q !== null) plano.push({ key: l.key, acao: "REDUZIR", quantidade: q });
    }
  }

  return plano;
}

/** Um produto do catálogo do fornecedor (D-723), no que o planejamento precisa. */
export interface ProdutoDoFornecedor {
  readonly skuId: string;
  readonly sku: string;
  readonly title: string | null;
  readonly supplierCode: string | null;
  readonly unitCost: number | null;
  readonly currency: string;
  readonly cadastroCost: number | null;
}

export interface PlanoFornecedor {
  /** O que entra no pedido, com a quantidade que o sistema compraria (MOQ e múltiplo já aplicados). */
  readonly trazer: readonly (ProdutoDoFornecedor & { readonly quantidade: number; readonly custo: number | null })[];
  /** Estoque e pedidos já cobrem: nada a comprar agora. */
  readonly semNecessidade: number;
  /** Sem base para número (fora da reposição, sem regra, histórico ou amostra). */
  readonly semDados: number;
  /** Já estavam no pedido. */
  readonly jaNoPedido: number;
}

/**
 * Planejamento por fornecedor (D-725): dos produtos que ele fornece, só os que
 * a avaliação manda comprar, na quantidade recomendada. O custo é o do
 * fornecedor quando em reais — outra moeda fica para o comprador converter,
 * nunca convertida a 1 —, senão o do cadastro.
 */
export function planoDoFornecedor(
  produtos: readonly ProdutoDoFornecedor[],
  avaliacoes: ReadonlyMap<string, AvaliacaoSku | null>,
  noPedido: ReadonlySet<string>,
): PlanoFornecedor {
  const trazer: (ProdutoDoFornecedor & { quantidade: number; custo: number | null })[] = [];
  let semNecessidade = 0;
  let semDados = 0;
  let jaNoPedido = 0;

  for (const p of produtos) {
    if (noPedido.has(p.skuId)) {
      jaNoPedido += 1;
      continue;
    }

    const q = avaliacoes.get(p.skuId)?.fit?.recommendedQuantity ?? null;

    if (q === null) semDados += 1;
    else if (q <= 0) semNecessidade += 1;
    else {
      const custo = p.currency === "BRL" && p.unitCost !== null ? p.unitCost : p.cadastroCost !== null && p.cadastroCost > 0 ? p.cadastroCost : null;

      trazer.push({ ...p, quantidade: q, custo });
    }
  }

  return { trazer, semNecessidade, semDados, jaNoPedido };
}
