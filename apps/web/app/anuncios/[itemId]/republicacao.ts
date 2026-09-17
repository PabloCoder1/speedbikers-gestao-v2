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
 * Variações em conta de user products (D-369) não republicam: o Mercado Livre
 * recusa com `item.variations.relist.invalid`. A recusa gravada com essa causa
 * não oferece botão e diz isso ao dono; o pedido reprovado pelo preflight
 * (`VARIACOES_USER_PRODUCT`) mostra a descrição do bloqueio.
 *
 * Esconder o botão é cortesia: papel, conta e elegibilidade são conferidos de
 * novo na `api` e no worker.
 *
 * Moram aqui também, pelo mesmo motivo, os textos das confirmações sobre as
 * variações que ficam fora do anúncio novo e o passo da espera pelo worker
 * (D-364).
 */

import type { RelistLeftOutVariation } from "@sb/domain";
import { RELIST_USER_PRODUCT_VARIATIONS_DESCRICAO, isRelistUserProductVariationsRejection } from "@sb/domain";

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
  /** `listing_relists.failure_reason` — por ele a tela reconhece a regra de D-369. */
  readonly failureReason: string | null;
}

export interface AtosDaRepublicacao {
  readonly pedir: boolean;
  readonly executar: boolean;
  readonly retomar: boolean;
  /** Em RELIST_FAILED, a explicação que a tela dá — com ou sem o botão. */
  readonly falha: "recusada" | "nao-permitida" | "exige-gente" | null;
  /** Em PREFLIGHT_FAILED pelo bloqueio de D-369, a descrição dele; senão `null`. */
  readonly bloqueio: string | null;
}

/** O que a tela diz quando o ML recusou por variações em conta de user products (D-369). */
export const MENSAGEM_NAO_PERMITIDA =
  "O Mercado Livre não permite republicar este anúncio (variações em conta de user products). Nenhum anúncio novo foi criado; o anúncio antigo segue fechado.";

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
    return { pedir: false, executar: false, retomar: false, falha: null, bloqueio: null };
  }

  const falhou = operacao?.status === "RELIST_FAILED";
  // D-369: a recusa por variações em conta de user products nunca oferece
  // botão, mesmo que a elegibilidade calculada dissesse o contrário.
  const naoPermitida = falhou && isRelistUserProductVariationsRejection(operacao.failureReason);
  const recusada = falhou && !naoPermitida && operacao.retomavel;
  const falha = falhou ? (naoPermitida ? "nao-permitida" : recusada ? "recusada" : "exige-gente") : null;
  const bloqueio =
    operacao?.status === "PREFLIGHT_FAILED" && operacao.failureReason?.includes(RELIST_USER_PRODUCT_VARIATIONS_DESCRICAO) === true
      ? RELIST_USER_PRODUCT_VARIATIONS_DESCRICAO
      : null;

  if (!podeRepublicar) {
    return { pedir: false, executar: false, retomar: false, falha, bloqueio };
  }

  return {
    pedir: operacao === null || !TRAVAM_NOVO_PEDIDO.includes(operacao.status),
    executar: operacao?.status === "REQUESTED",
    retomar: recusada,
    falha,
    bloqueio,
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
 * conferência (anúncio não fechado, já republicado, sem estoque ou com
 * variações em conta de user products), o CAS perdido para outra execução,
 * ou só uma fila atrasada. A tela não sabe qual — diz o que conferir.
 */
export const MENSAGEM_SEM_RESPOSTA =
  "A operação não mudou em 30 segundos. O worker pode só estar atrasado: recarregue a página em alguns minutos. Se continuar igual, a tentativa parou numa conferência do worker (anúncio que não está fechado, que já foi republicado, sem estoque ou com variações em conta de user products) e o motivo está no log dele — confira o anúncio no Mercado Livre antes de tentar de novo.";
