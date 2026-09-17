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
 */

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
