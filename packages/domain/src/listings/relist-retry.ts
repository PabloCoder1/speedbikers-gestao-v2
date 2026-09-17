/**
 * Retomada humana de um relist RECUSADO (D-364) — a única saída de
 * RELIST_FAILED que esta casa oferece, e só quando é comprovadamente segura.
 *
 * RELIST_FAILED é "pai fechado sem filho confirmado" (D-159), e a regra do
 * executor é nunca repetir o POST sozinho: um 5xx, um timeout ou uma resposta
 * perdida podem significar que o filho NASCEU, e repetir criaria dois. Uma
 * recusa 4xx é outra coisa: o Mercado Livre leu o pedido e disse não —
 * nenhum anúncio novo foi criado. Nesse caso, e SÓ nele, uma pessoa pode
 * mandar tentar de novo.
 *
 * Menos quando a recusa é por regra da CONTA (D-369): o relist de item com
 * variações de vendedor no modelo de user products volta sempre com
 * `item.variations.relist.invalid`, e oferecer outra tentativa seria pedir
 * outro 400.
 *
 * Três camadas aplicam ESTA mesma regra: a tela (para oferecer o botão), a
 * `api` (para aceitar o pedido) e o worker (para emitir o POST). Nenhuma
 * confia na anterior.
 */

/** Motivo do evento RELIST_FAILED quando o Mercado Livre recusou o POST (4xx). */
export const RELIST_POST_REJECTED_REASON = "POST_RECUSADO";

/** Motivo do evento RELIST_FAILED quando o POST falhou sem prova de que o filho não nasceu. */
export const RELIST_POST_FAILED_REASON = "POST_FALHOU";

/** Motivo do evento RELIST_FAILED → RELISTING da retomada humana. */
export const RELIST_RETRY_REASON = "RETOMADA_APOS_RECUSA";

/**
 * O status HTTP que prova recusa: 4xx, menos 408 (timeout — o pedido pode ter
 * sido processado) e 429 (limite — sem prova de que não foi). Só vale como
 * prova porque o POST /relist sai com UMA tentativa no cliente HTTP: um 4xx
 * depois de um 5xx repetido pelo cliente seria a recusa da REPETIÇÃO, com o
 * filho talvez vivo.
 */
export function isRelistRejectionStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 400 && status <= 499 && status !== 408 && status !== 429;
}

/**
 * O `failure_reason` de uma recusa, gravado no MESMO update que põe a operação
 * em RELIST_FAILED. É por ele que a regra confere o evento `POST_RECUSADO`.
 */
export function relistRejectionFailureReason(status: number, summary: string): string {
  return `o Mercado Livre recusou a republicação (HTTP ${String(status)}) — nenhum anúncio novo foi criado. Resposta: ${summary}`;
}

const REJECTION_FAILURE = /^o Mercado Livre recusou a republicação \(HTTP (\d{3})\) — nenhum anúncio novo foi criado\./u;

/**
 * A causa com que o Mercado Livre recusa relist de item COM variações de
 * vendedor no modelo de user products (D-369) — resposta real de 17/09/2026
 * 13:36 UTC ao MLB1476804187, operação a7638dc5.
 */
export const RELIST_USER_PRODUCT_VARIATIONS_CAUSE = "item.variations.relist.invalid";

/**
 * A causa como código inteiro: nem prefixo nem sufixo de outro código. O
 * ponto que fecha a frase ("... invalid.") não é sufixo — só ponto seguido de
 * letra, dígito ou `_` continuaria o código.
 */
const USER_PRODUCT_VARIATIONS_CAUSE = /(?<![\w.])item\.variations\.relist\.invalid(?!\w|\.\w)/u;

/**
 * `true` sse o texto menciona a causa de D-369 como código inteiro. É a mesma
 * regra da leitura do `failure_reason`: o worker a usa para garantir que o
 * resumo do corpo de erro não perca a causa (D-369).
 */
export function mentionsRelistUserProductVariationsCause(text: string): boolean {
  return USER_PRODUCT_VARIATIONS_CAUSE.test(text);
}

/**
 * `true` sse o `failure_reason` é uma RECUSA gravada (`relistRejectionFailureReason`)
 * cuja resposta do Mercado Livre traz a causa de D-369. Essa recusa não muda
 * com outra tentativa: a regra está na conta, não no pedido.
 */
export function isRelistUserProductVariationsRejection(failureReason: string | null): boolean {
  if (failureReason === null) {
    return false;
  }

  const rejection = REJECTION_FAILURE.exec(failureReason);

  return rejection !== null && mentionsRelistUserProductVariationsCause(failureReason.slice(rejection[0].length));
}

export interface RelistRetryCandidate {
  readonly status: string;
  readonly parentItemId: string;
  /** `listing_relists.failure_reason` como está gravado (no mesmo update do status). */
  readonly failureReason: string | null;
  /** `reason` do ÚLTIMO evento com `to_status` RELIST_FAILED; `null` sem evento ou sem motivo. */
  readonly lastFailedEventReason: string | null;
}

/**
 * A mensagem que o executor gravava ANTES de D-364 para qualquer falha do
 * POST — inclusive a recusa 400 do MLB1476804187 (operação a7638dc5). O texto
 * do `http-client` só diz o status e o caminho; é tudo o que existe para
 * provar a recusa dessas operações, e por isso o casamento é exato.
 */
const LEGACY_POST_FAILURE = /^o POST \/relist falhou e não é seguro repetir: Mercado Livre respondeu (\d{3}) para POST \/items\/(MLB\d+)\/relist\.$/u;

/**
 * Elegível sse a operação está em RELIST_FAILED e a ÚLTIMA falha registrada é
 * uma recusa comprovada: `POST_RECUSADO`, ou (legado) `POST_FALHOU` com a
 * mensagem antiga de um 4xx recusável para o POST deste mesmo pai.
 *
 * O evento e a linha precisam concordar. O evento é gravado numa chamada
 * separada, e perdê-lo é só log (`relist_event_not_recorded`): uma retomada
 * que levou 5xx e não gravou o `POST_FALHOU` deixaria o `POST_RECUSADO` antigo
 * como último evento. O `failure_reason` sai no mesmo update do status, então
 * é ele que desempata — com a mensagem de recusa, e de um status que prova
 * recusa.
 */
export function isRelistRetryEligible(candidate: RelistRetryCandidate): boolean {
  if (candidate.status !== "RELIST_FAILED") {
    return false;
  }

  if (candidate.lastFailedEventReason === RELIST_POST_REJECTED_REASON) {
    const rejection = candidate.failureReason === null ? null : REJECTION_FAILURE.exec(candidate.failureReason);

    // D-369: a recusa por variações de user products é definitiva — tentar
    // de novo só traria outro 400.
    return (
      rejection !== null &&
      isRelistRejectionStatus(Number(rejection[1])) &&
      !isRelistUserProductVariationsRejection(candidate.failureReason)
    );
  }

  if (candidate.lastFailedEventReason !== RELIST_POST_FAILED_REASON || candidate.failureReason === null) {
    return false;
  }

  const legacy = LEGACY_POST_FAILURE.exec(candidate.failureReason);

  if (legacy === null) {
    return false;
  }

  return isRelistRejectionStatus(Number(legacy[1])) && legacy[2] === candidate.parentItemId;
}
