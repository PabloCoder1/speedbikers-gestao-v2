/**
 * O limite das reversões de uma venda (D-351, verificação de e6fda07, ALTA-1).
 *
 * Cancelamento (`CANCELAMENTO_ML`, chave `cancelamento:<chave da venda>`) e
 * devolução entregue (`DEVOLUCAO_ML`, chave `devolucao:<claim>:<chave da venda>`)
 * revertem o MESMO `VENDA_ML`. Desde D-052 e D-057 nenhum dos dois olhava o
 * outro: o pedido cancelado E devolvido voltava +2 para 1 unidade vendida. Em
 * produção, em 2026-09-15, eram 2 pedidos (2000018212899604 e 2000018206306064);
 * no Dev, 563 das 580 devoluções tinham também o cancelamento da mesma venda.
 *
 * O invariante físico, que decorre das respostas do dono: **uma unidade vendida
 * volta ao estoque NO MÁXIMO uma vez**, seja por cancelamento, seja por
 * devolução. Por isso a reversão é limitada POR QUANTIDADE de cada linha de
 * venda — o total revertido pelas duas causas nunca passa da quantidade vendida.
 * A reversão nova grava só o que falta; a que não tem mais o que reverter não
 * grava nada.
 *
 * **A reversão com a MESMA chave fica fora da soma.** Reprocessar o mesmo
 * cancelamento (ou a mesma devolução) precisa calcular o MESMO movimento da
 * primeira vez — o `UNIQUE` de `idempotency_key` o absorve. Somando a própria
 * linha, o reprocessamento calcularia zero e passaria a registrar como "já
 * revertida" a reversão que ele mesmo gravou.
 *
 * **O que isto não cobre:** duas reversões da mesma venda calculadas AO MESMO
 * TEMPO, cada uma antes de a outra gravar (o webhook do pedido e o do claim na
 * mesma janela de leitura). As duas leem "nada revertido" e as duas gravam. É
 * uma corrida de leitura, sem trava no banco; registrada como resíduo em D-351.
 */

/** Uma reversão já gravada de um `VENDA_ML`: `CANCELAMENTO_ML` ou `DEVOLUCAO_ML`. */
export interface RecordedReversal {
  /** `cancelamento:<chave da venda>` ou `devolucao:<claim>:<chave da venda>`. */
  readonly idempotencyKey: string;
  /** Unidades devolvidas ao saldo: o `qty_delta` da linha, positivo. */
  readonly quantity: number;
}

export const CANCELAMENTO_KEY_PREFIX = "cancelamento:";
export const DEVOLUCAO_KEY_PREFIX = "devolucao:";
const VENDA_KEY_PREFIX = "venda:";

/** A chave do cancelamento de uma venda. */
export function cancellationKeyOf(saleKey: string): string {
  return `${CANCELAMENTO_KEY_PREFIX}${saleKey}`;
}

/** A chave da devolução de uma venda por um claim. */
export function returnKeyOf(claimId: string, saleKey: string): string {
  return `${DEVOLUCAO_KEY_PREFIX}${claimId}:${saleKey}`;
}

/**
 * A chave do `VENDA_ML` revertido, lida da chave de uma reversão. LANÇA para
 * chave fora dos dois formatos: uma reversão que não diz qual venda reverteu
 * faria a venda parecer não revertida — e a próxima reversão devolveria a
 * unidade de novo.
 */
export function revertedSaleKeyOf(reversalKey: string): string {
  let saleKey: string | null = null;

  if (reversalKey.startsWith(CANCELAMENTO_KEY_PREFIX)) {
    saleKey = reversalKey.slice(CANCELAMENTO_KEY_PREFIX.length);
  } else if (reversalKey.startsWith(DEVOLUCAO_KEY_PREFIX)) {
    const resto = reversalKey.slice(DEVOLUCAO_KEY_PREFIX.length);
    const separador = resto.indexOf(":");

    // O claim é o trecho até o primeiro ":" e não pode ser vazio.
    if (separador > 0) {
      saleKey = resto.slice(separador + 1);
    }
  }

  if (saleKey === null || !saleKey.startsWith(VENDA_KEY_PREFIX) || saleKey.length === VENDA_KEY_PREFIX.length) {
    throw new Error(
      `chave de reversao fora do formato "${CANCELAMENTO_KEY_PREFIX}<venda>" ou "${DEVOLUCAO_KEY_PREFIX}<claim>:<venda>": ${reversalKey}`,
    );
  }

  return saleKey;
}

/** Soma com três casas, a precisão de `stock_movements.qty_delta` (`numeric(14, 3)`). */
function arredonda(valor: number): number {
  return Math.round(valor * 1000) / 1000;
}

/** Quanto de uma venda já foi revertido, pelas duas causas — sem a reversão de chave `exceptKey`. */
export function reversedQuantity(
  saleKey: string,
  reversals: readonly RecordedReversal[],
  exceptKey: string | null = null,
): number {
  let total = 0;

  for (const reversal of reversals) {
    if (reversal.idempotencyKey === exceptKey) continue;

    if (revertedSaleKeyOf(reversal.idempotencyKey) === saleKey) {
      total += reversal.quantity;
    }
  }

  return arredonda(total);
}

/**
 * Quanto uma reversão de chave `ownKey` ainda pode devolver desta venda: a
 * quantidade vendida menos o que as OUTRAS reversões já devolveram, nunca menos
 * que zero.
 */
export function remainingToReverse(
  sale: { readonly idempotencyKey: string; readonly qtyDelta: number },
  reversals: readonly RecordedReversal[],
  ownKey: string,
): number {
  return Math.max(0, arredonda(Math.abs(sale.qtyDelta) - reversedQuantity(sale.idempotencyKey, reversals, ownKey)));
}

/**
 * O que já foi revertido ALÉM da quantidade vendida. Com o limite acima, nenhuma
 * reversão nova cria excesso: ele só existe no legado gravado antes deste limite
 * (os 2 pedidos de produção com devolução E cancelamento).
 */
export function excessReversed(
  sale: { readonly idempotencyKey: string; readonly qtyDelta: number },
  reversals: readonly RecordedReversal[],
): number {
  return Math.max(0, arredonda(reversedQuantity(sale.idempotencyKey, reversals) - Math.abs(sale.qtyDelta)));
}
