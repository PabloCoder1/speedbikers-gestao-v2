/**
 * O QUE O PAINEL DE REPUBLICAÇÃO OFERECE — pura e sem React, para o critério
 * ser testável sem renderizar a página (o mesmo raciocínio de `checagem.ts`).
 *
 * Três atos, cada um com o estado que o permite:
 *
 *  - **pedir** (D-161): só quando não há operação que trave o pai;
 *  - **executar** (D-162): só com a operação em REQUESTED;
 *  - **tentar de novo** (D-364): só em RELIST_FAILED cuja última falha foi
 *    RECUSA comprovada do Mercado Livre (`isRelistRetryEligible`, calculado
 *    pela página). Qualquer outra falha em RELIST_FAILED — 5xx, execução
 *    interrompida, resposta ambígua — pode ter criado o anúncio novo, e a tela
 *    diz que exige gente em vez de oferecer o botão.
 *
 * Esconder o botão é cortesia: papel, conta e elegibilidade são conferidos de
 * novo na `api` e no worker.
 *
 * Moram aqui também, pelo mesmo motivo, os textos das confirmações sobre as
 * variações que ficam fora do anúncio novo e o passo da espera pelo worker
 * (D-364).
 */

import type { RelistLeftOutVariation } from "@sb/domain";

/**
 * Estados que TRAVAM uma operação nova para o mesmo pai — o predicado de
 * `listing_relists_one_live_per_parent` (tudo menos PREFLIGHT_FAILED e
 * CLOSE_FAILED). RELIST_FAILED está aqui: pedir de novo com o pai fechado sem
 * filho cairia no índice e morreria em silêncio no worker.
 */
export const TRAVAM_NOVO_PEDIDO: readonly string[] = [
  "REQUESTED",
  "CLOSING",
  "CLOSED",
  "RELISTING",
  "RELISTED",
  "RELIST_FAILED",
  "REMAPPED",
];

export interface OperacaoDoPainel {
  readonly status: string;
  /** `isRelistRetryEligible` da operação, com o último evento de falha. */
  readonly retomavel: boolean;
}

export interface AtosDaRepublicacao {
  readonly pedir: boolean;
  readonly executar: boolean;
  readonly retomar: boolean;
  /** Em RELIST_FAILED, a explicação que a tela dá — com ou sem o botão. */
  readonly falha: "recusada" | "exige-gente" | null;
}

export function atosDaRepublicacao({
  podeRepublicar,
  operacao,
  aguardandoWorker,
}: {
  readonly podeRepublicar: boolean;
  readonly operacao: OperacaoDoPainel | null;
  /** Um ato foi enviado e o worker ainda não mudou a operação (D-360). */
  readonly aguardandoWorker: boolean;
}): AtosDaRepublicacao {
  if (aguardandoWorker) {
    return { pedir: false, executar: false, retomar: false, falha: null };
  }

  const falhou = operacao?.status === "RELIST_FAILED";
  const recusada = falhou && operacao.retomavel;
  const falha = falhou ? (recusada ? "recusada" : "exige-gente") : null;

  if (!podeRepublicar) {
    return { pedir: false, executar: false, retomar: false, falha };
  }

  return {
    pedir: operacao === null || !TRAVAM_NOVO_PEDIDO.includes(operacao.status),
    executar: operacao?.status === "REQUESTED",
    retomar: recusada,
    falha,
  };
}

/**
 * Uma variação que fica FORA do anúncio novo, como a confirmação a lista
 * (D-364): o id do Mercado Livre sempre, a combinação e o SKU quando existem.
 */
export function descreverVariacaoFora(variacao: RelistLeftOutVariation): string {
  return [variacao.id, variacao.label, variacao.sku === null ? null : `SKU ${variacao.sku}`]
    .filter((parte) => parte !== null)
    .join(" · ");
}

/**
 * O que a caixa de ciência da EXECUÇÃO diz. Com variação de fora, a ciência
 * cobre as duas perdas: o anúncio fechado e as variações que não voltam.
 */
export function cienciaDaExecucao(variacoesFora: number): string {
  return variacoesFora === 0
    ? "Entendo que fechar este anúncio é irreversível."
    : "Entendo que fechar este anúncio é irreversível e que o anúncio novo nasce sem as variações sem estoque listadas.";
}

/** A retomada não fecha nada; só exige ciência quando alguma variação fica de fora. */
export function cienciaDaRetomada(variacoesFora: number): string | undefined {
  return variacoesFora === 0 ? undefined : "Entendo que o anúncio novo nasce sem as variações sem estoque listadas.";
}

/** Quantas vezes, e de quanto em quanto, a tela relê depois de enviar um ato (D-360). */
export const RELEITURAS = 10;
export const INTERVALO_MS = 3_000;

/**
 * O passo `leitura` (1, 2, …) da espera pelo worker: relê enquanto couber e,
 * passada a última releitura, DESISTE — a tela sai da espera e diz que nada
 * mudou, em vez de manter "enfileirado" para sempre.
 */
export function passoDaReleitura(leitura: number): "reler" | "desistir" {
  return leitura <= RELEITURAS ? "reler" : "desistir";
}

/**
 * O worker pode terminar SEM mudar a operação: a retomada que reprova na
 * conferência (anúncio não fechado, já republicado ou sem estoque), o CAS
 * perdido para outra execução, ou só uma fila atrasada. A tela não sabe qual —
 * diz o que conferir.
 */
export const MENSAGEM_SEM_RESPOSTA =
  "A operação não mudou em 30 segundos. O worker pode só estar atrasado: recarregue a página em alguns minutos. Se continuar igual, a tentativa parou numa conferência do worker (anúncio que não está fechado, que já foi republicado ou sem estoque) e o motivo está no log dele — confira o anúncio no Mercado Livre antes de tentar de novo.";
