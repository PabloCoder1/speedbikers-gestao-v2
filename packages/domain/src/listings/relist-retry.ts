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
 * sido processado) e 429 (limite — idem, e o cliente HTTP já repete 429).
 */
export function isRelistRejectionStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 400 && status <= 499 && status !== 408 && status !== 429;
}

export interface RelistRetryCandidate {
  readonly status: string;
  readonly parentItemId: string;
  /** `listing_relists.failure_reason` como está gravado. */
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
 */
export function isRelistRetryEligible(candidate: RelistRetryCandidate): boolean {
  if (candidate.status !== "RELIST_FAILED") {
    return false;
  }

  if (candidate.lastFailedEventReason === RELIST_POST_REJECTED_REASON) {
    return true;
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
