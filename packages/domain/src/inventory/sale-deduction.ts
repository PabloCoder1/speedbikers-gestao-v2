/**
 * Dedução de estoque por venda — a peça pura de
 * `apps/worker/src/handlers/persist-order.ts`, chamada a cada order
 * persistida.
 *
 * D-019: a venda vira linha no ledger no momento em que o pedido é
 * persistido, não calculada na leitura. `docs/DATABASE.md` secao 4: venda
 * de SKU de kit gera movimentos dos COMPONENTES — o kit não tem saldo
 * próprio (`skus.kind = 'KIT'` não é `PRODUTO`).
 *
 * Reversão por cancelamento/devolução é o PRÓXIMO item do checklist da
 * Fase 4 (`docs/ROADMAP.md`), de propósito separado: esta função só deduz
 * na direção de venda confirmada, nunca reverte.
 *
 * **D-351 — a venda anterior ao snapshot do ERP.** O saldo da planilha do
 * UpSeller é o Disponível no instante da EXPORTAÇÃO, e o UpSeller puxa o pedido
 * do Mercado Livre na hora: toda venda anterior a esse corte já está descontada
 * lá. Em produção, pedidos antigos atualizados depois da planilha geravam o
 * primeiro `VENDA_ML` deles e o saldo contava a venda duas vezes (D-350 §5).
 *
 * A saída é "grava e estorna": a venda continua sendo gravada — cancelamento e
 * devolução posteriores precisam dela como base —, e cada rascunho cuja "venda
 * em" (`date_closed ?? date_created`) é MENOR OU IGUAL ao corte do SKU sai com
 * um par `ESTORNO_PRE_CAPTURA` de quantidade oposta e a MESMA `occurred_at`.
 * O par soma zero no saldo e, por ter a mesma data, fica do mesmo lado do corte
 * em `compute_erp_target_balances` (que soma só `occurred_at > captured_at`):
 * soma zero no alvo também. A fronteira é a mesma nos dois lugares — `<=` aqui,
 * `>` lá.
 *
 * **Só estorna movimento que entrou no saldo DEPOIS de o corte chegar.** Uma
 * venda gravada antes do import da planilha já estava no saldo quando o corte
 * mudou: o salto do alvo (`snapshot novo − movimentos até o corte`) a absorveu,
 * e a reconciliação alinhou o saldo. Estorná-la depois devolveria a unidade que
 * a planilha já não tem — a cada planilha nova, quase toda venda dos dias
 * anteriores ganharia um +1 falso (revisão de D-351, ALTA-1). Por isso o corte
 * traz `importedAt`, e a venda gravada traz `recordedAt`.
 *
 * **O que a planilha tem e de que lado do alvo a linha está são duas perguntas**
 * (reverificação de c48fb70, MÉDIA-1). "A venda está na planilha?" é respondida
 * pela exportação (`exportedAt`); "a linha gravada está dentro do alvo?", pelo
 * corte do alvo (`capturedAt`). Quase sempre são o mesmo instante. Diferem no
 * snapshot que ainda carrega o parse de uma planilha com o nome carimbado — a
 * organização reconciliada que a migration deixou no parse, o Dev —, e ali a
 * venda entre a exportação e o parse não é estornada.
 */

import { excessReversalShares } from "./reversal-limit.js";
import type { TimedRecordedReversal } from "./reversal-limit.js";

export interface SaleDeductionItem {
  readonly position: number;
  readonly quantity: number;
  readonly skuId: string | null;
  /** `null` quando `skuId` também é `null` — item sem vínculo, nada a deduzir. */
  readonly skuKind: "PRODUTO" | "KIT" | null;
  /** Só relevante quando `skuKind === "KIT"`. */
  readonly components: readonly { componentSkuId: string; quantity: number }[];
}

export interface SaleDeductionOrder {
  readonly id: number;
  readonly status: string;
  /** `orders.date_created`. */
  readonly dateCreated: Date;
  /**
   * `orders.date_closed` — a confirmação da venda. Nulo cai em `dateCreated`.
   *
   * É ESTE instante, e não `date_last_updated`, que diz de que lado do snapshot
   * a venda está (D-351). Um pedido criado às 18:40:52 e fechado às 18:55:00
   * existe em produção: por `date_created` ele pareceria anterior a um corte
   * das 18:42.
   */
  readonly dateClosed: Date | null;
  readonly items: readonly SaleDeductionItem[];
}

export interface StockMovementDraft {
  readonly skuId: string;
  /** Negativo na dedução; positivo em reversão e estorno. */
  readonly qtyDelta: number;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  /**
   * `undefined` para os casos existentes (venda, cancelamento, NF-e — todos
   * sempre LOCAL). Explícito só quando o draft não é LOCAL, como a
   * reconciliação contra o UpSeller gerando ajuste em RESERVADO
   * (`@sb/domain/inventory`, `computeReconciliationAdjustments`).
   */
  readonly locationKind?: "LOCAL" | "RESERVADO" | "TRANSITO";
}

/** Um `VENDA_ML` já gravado no ledger, na forma que o estorno precisa espelhar. */
export interface RecordedSale {
  readonly skuId: string;
  readonly qtyDelta: number;
  readonly occurredAt: Date;
  /** `stock_movements.created_at`: quando a venda entrou no saldo. */
  readonly recordedAt: Date;
}

/** O corte do snapshot do ERP para um SKU (D-351), como `get_erp_stock_cutoffs` o devolve. */
export interface ErpCutoff {
  /**
   * `erp_stock_snapshots.captured_at` — o corte do ALVO: `compute_erp_target_balances`
   * soma os movimentos com `occurred_at` depois dele. Diz de que lado do alvo
   * está uma linha já gravada (`estornaVendaGravada`, ramo (a)). É o instante
   * da exportação, exceto no snapshot que ainda carrega o parse (`exportedAt`).
   */
  readonly capturedAt: Date;
  /**
   * O instante que o saldo da planilha RETRATA: a exportação. Venda (e
   * cancelamento) com instante até aqui já está no saldo do ERP. É o próprio
   * `capturedAt`, exceto quando o snapshot vencedor ainda carrega o parse de
   * uma planilha com o nome carimbado — a organização reconciliada que a
   * migration `20260916180000` deixa no parse (o Dev: exportada em 08-20
   * 16:09:23, corte em 08-21 15:42:02.459). Ali a venda entre a exportação e o
   * parse NÃO está na planilha, e estorná-la subiria alvo e saldo juntos
   * (reverificação de c48fb70, MÉDIA-1). Sempre `<= capturedAt`.
   */
  readonly exportedAt: Date;
  /**
   * Quando a V3 terminou de receber esse corte: `erp_import_batches.applied_at`
   * do lote do snapshot mais recente (gravado depois de todos os upserts), ou o
   * `created_at` dele quando o lote ainda não fechou — o maior dos dois. Venda
   * gravada até aqui já estava no saldo quando o corte chegou.
   */
  readonly importedAt: Date;
  /**
   * A última reconciliação da organização (`maintenance.reconcile-balances`
   * concluída, ou o último `AJUSTE_RECONCILIACAO`), ou `null` se nunca houve.
   * Uma reconciliação depois do import alinha o saldo ao alvo e absorve a venda
   * gravada antes dela (verificação de e6fda07, MÉDIA-1). Também `null` para o
   * SKU sem snapshot próprio (que usa o corte da organização): ele não tem alvo,
   * a reconciliação nunca o visita, e nenhuma rodada alinha o saldo dele.
   */
  readonly reconciledAt: Date | null;
}

export interface PreCaptureCutoffs {
  /**
   * O corte do SKU: o snapshot mais recente dele, ou o da organização quando o
   * SKU não tem snapshot próprio. `null` = a organização não tem snapshot
   * nenhum, e aí não há o que estornar.
   *
   * O chamador LANÇA para SKU cujo corte não foi lido — "não sei" nunca pode
   * virar "sem corte", porque "sem corte" é exatamente a dupla contagem.
   */
  readonly cutoffFor: (skuId: string) => ErpCutoff | null;
  /**
   * O `VENDA_ML` já gravado com esta chave, se existir.
   *
   * Existe porque o worker de antes de D-351 gravou venda com `occurred_at =
   * date_last_updated`. Um estorno com a "venda em" nova, para uma venda
   * gravada com a data velha, somaria zero no saldo e NÃO no alvo — cada linha
   * cairia de um lado do corte. Espelhar a linha gravada (SKU, quantidade e
   * data) é o que mantém o par nulo nos dois lados, e é a mesma regra da
   * compensação dos movimentos já gravados.
   */
  readonly recordedSale: (idempotencyKey: string) => RecordedSale | undefined;
  /**
   * `CANCELAMENTO_ML` e `DEVOLUCAO_ML` já gravados do pedido, com o instante de cada
   * um. O legado de antes do limite das reversões (`reversal-limit.ts`) pode ter
   * revertido a mesma venda duas vezes: a reversão a mais ganha a própria anulação
   * junto com o estorno (`excessReversalEstornosOf`, D-351 §12).
   */
  readonly recordedReversals: readonly TimedRecordedReversal[];
}

export interface SaleDeductionResult {
  readonly deductions: StockMovementDraft[];
  /** Movimentos `ESTORNO_PRE_CAPTURA`, um por dedução anterior ou igual ao corte. */
  readonly preCaptureReversals: StockMovementDraft[];
  /**
   * Movimentos `ESTORNO_REVERSAO_EXCEDENTE`: a anulação da reversão a mais do legado
   * das vendas estornadas agora, uma por reversão que passou da venda (D-351 §12).
   */
  readonly excessReversalEstornos: StockMovementDraft[];
}

/**
 * Prefixo NEUTRO da chave de estorno: `estorno:<chave do movimento estornado>`,
 * qualquer que seja a causa.
 *
 * O TIPO do movimento diz a causa (`ESTORNO_PRE_CAPTURA`; na fatia do Full,
 * `ESTORNO_FULL`); a CHAVE diz o movimento. Com um prefixo por causa, dois
 * estornos do mesmo movimento teriam chaves diferentes e o `UNIQUE` de
 * `idempotency_key` deixaria os dois entrarem. Impedir isso pediria um índice
 * único a mais — e o lote da página trata QUALQUER 23505 como idempotência
 * (`page-writes.ts`), então a violação desse índice apagaria os movimentos da
 * página inteira em silêncio. Com a chave neutra, o `UNIQUE` que já existe
 * absorve o segundo estorno.
 */
export const ESTORNO_KEY_PREFIX = "estorno:";

/** A chave do estorno de um movimento. */
export function estornoKeyOf(movementKey: string): string {
  return `${ESTORNO_KEY_PREFIX}${movementKey}`;
}

/**
 * A chave do movimento estornado, lida da chave de um estorno. LANÇA para chave
 * fora do formato: uma linha de estorno que não diz o que estorna faria a venda
 * dela parecer não estornada — e a reversão decidiria com o dado errado.
 */
export function estornadoKeyOf(estornoKey: string): string {
  if (!estornoKey.startsWith(ESTORNO_KEY_PREFIX) || estornoKey.length === ESTORNO_KEY_PREFIX.length) {
    throw new Error(`chave de estorno fora do formato "${ESTORNO_KEY_PREFIX}<chave do movimento>": ${estornoKey}`);
  }

  return estornoKey.slice(ESTORNO_KEY_PREFIX.length);
}

/**
 * Mesma semântica de "venda válida" já aprovada para métricas (D-050):
 * `paid` ou `partially_refunded`. A chave de idempotência NÃO inclui o
 * status — reprocessar o mesmo pedido em qualquer uma dessas duas
 * situações produz a MESMA chave, e o `UNIQUE` do banco absorve o reenvio
 * sem duplicar, sem precisar rastrear transição de status aqui (o mesmo
 * raciocínio que já livra `detectOrderStatusEvents` de guardar estado
 * entre chamadas).
 */
const VALID_SALE_STATUSES = new Set(["paid", "partially_refunded"]);

export function isValidSaleStatus(status: string): boolean {
  return VALID_SALE_STATUSES.has(status);
}

/** "Venda em": a confirmação, e na falta dela a criação (D-351). */
export function saleInstant(order: Pick<SaleDeductionOrder, "dateClosed" | "dateCreated">): Date {
  return order.dateClosed ?? order.dateCreated;
}

/**
 * O último instante em que o saldo foi alinhado a este corte: o import dele, ou
 * uma reconciliação posterior ao import.
 */
export function alignedAt(cutoff: ErpCutoff): Date {
  return cutoff.reconciledAt !== null && cutoff.reconciledAt.getTime() > cutoff.importedAt.getTime()
    ? cutoff.reconciledAt
    : cutoff.importedAt;
}

/**
 * Se um `VENDA_ML` JÁ GRAVADO, de venda até o corte, ainda precisa de estorno
 * (verificação de e6fda07, MÉDIA-1). Quem absorve a venda gravada não é o import:
 * é o alinhamento do saldo ao alvo. Por isso a regra olha de que lado do corte a
 * LINHA está:
 *
 *  - (a) `occurred_at` da linha DEPOIS do corte do alvo (`capturedAt`, e não
 *    `exportedAt`: o lado do alvo é o de `compute_erp_target_balances`): a linha
 *    está dentro do alvo (é o worker de antes de D-351, que gravava a data da
 *    atualização) e conta a venda duas vezes nos dois lados. O estorno espelhado
 *    a anula no saldo E no alvo: estorna sempre, com ou sem reconciliação no
 *    meio. A fronteira é estrita, como lá: a linha com `occurred_at` IGUAL ao
 *    corte está fora do alvo e cai em (b) (reverificação de c48fb70, MUT-X2).
 *  - (b) `occurred_at` até o corte: a linha está fora do alvo. Se ela já estava
 *    no saldo no último alinhamento a este corte (`alignedAt`: o import, ou uma
 *    reconciliação depois dele), o saldo já foi posto igual ao alvo sem ela — a
 *    venda foi absorvida, e estorná-la devolveria uma unidade que a planilha não
 *    tem. Só estorna o que entrou no saldo DEPOIS desse alinhamento.
 */
export function estornaVendaGravada(recorded: RecordedSale, cutoff: ErpCutoff): boolean {
  if (recorded.occurredAt.getTime() > cutoff.capturedAt.getTime()) {
    return true;
  }

  return recorded.recordedAt.getTime() > alignedAt(cutoff).getTime();
}

/**
 * O `ESTORNO_PRE_CAPTURA` de uma venda — o rascunho novo ou a linha já gravada
 * com a mesma chave —, ou `null` quando ela não é estornada.
 *
 * Estorna quando a "venda em" é até a EXPORTAÇÃO da planilha do SKU
 * (`exportedAt`: a planilha tem a venda) E a venda ainda não foi absorvida: o
 * rascunho novo sempre (vai ser gravado agora); a linha gravada, pela regra de
 * `estornaVendaGravada`. A quantidade é a da VENDA inteira, sempre: o excesso de
 * reversão do legado não é descontado daqui, e sim anulado por movimento próprio
 * (`excessReversalEstornosOf`, D-351 §12). Compartilhada com o cancelamento
 * (`computeCancellationMovements`), que precisa do mesmo par.
 *
 * O gate é `exportedAt`, e não `capturedAt` (reverificação de c48fb70,
 * MÉDIA-1): no snapshot que ainda carrega o parse, a venda entre a exportação e
 * o parse não está na planilha. Nada dela é estornado — nem o rascunho novo,
 * nem a linha do worker antigo que o alvo já conta.
 */
export function preCaptureEstornoOf(
  sale: StockMovementDraft,
  saleAt: Date,
  preCapture: PreCaptureCutoffs,
): StockMovementDraft | null {
  // A linha que de fato move (ou moverá) o saldo: a já gravada, se houver —
  // o `UNIQUE` descarta o rascunho novo com a mesma chave.
  const recorded = preCapture.recordedSale(sale.idempotencyKey);
  const base = recorded ?? sale;
  const cutoff = preCapture.cutoffFor(base.skuId);

  if (cutoff === null || saleAt.getTime() > cutoff.exportedAt.getTime()) {
    return null;
  }

  if (recorded !== undefined && !estornaVendaGravada(recorded, cutoff)) {
    return null;
  }

  // A venda INTEIRA, com o instante dela. Até a reverificação de cc90baa o estorno
  // descontava o excesso de reversão do legado (cancelamento E devolução da mesma
  // venda) -- a conta só fechava com a venda e a reversão a mais do mesmo lado do
  // corte do alvo. Com a venda gravada ATÉ o corte e as reversões depois dele
  // (2000017792822486 de produção, KIT de 3 componentes), o estorno descontado
  // caía fora do alvo e a reversão a mais ficava dentro: alvo +2 para real +1. O
  // excesso agora é anulado com o instante da reversão (`excessReversalEstornosOf`).
  return {
    skuId: base.skuId,
    qtyDelta: -base.qtyDelta,
    idempotencyKey: estornoKeyOf(sale.idempotencyKey),
    occurredAt: base.occurredAt,
  };
}

/**
 * A anulação da reversão a mais do legado de uma venda estornada (D-351 §12):
 * `ESTORNO_REVERSAO_EXCEDENTE`, um por reversão que passou da quantidade vendida
 * (`excessReversalShares`), com a quantidade que passou, o SKU da venda e o
 * `occurred_at` ESPELHADO da reversão. Vazio quando nada passou (`R <= V`).
 *
 * **Por que um movimento próprio, e não o estorno menor.** A conta de cada pedido
 * estornado, com V = unidades vendidas, R = revertidas e E = max(0, R - V), tem de
 * dar +min(R, V) no saldo E no alvo de `compute_erp_target_balances` (que só soma
 * `occurred_at > captured_at`). Estorno de V com o instante da venda e anulação de E
 * com o instante da reversão a mais dão: saldo = -V + V + R - E = min(R, V); alvo =
 * as linhas do lado de dentro, e cada par (venda, estorno) e (reversão, anulação)
 * fica do mesmo lado do corte -- qualquer que seja o lado da venda. O estorno de
 * V - E com o instante da venda só acertava o alvo quando venda e reversão a mais
 * estavam do mesmo lado.
 *
 * **Tipo e chave.** O tipo diz a causa (não é estorno de venda, e quem lê
 * `ESTORNO_PRE_CAPTURA` para achar venda estornada não o vê); a chave é a neutra,
 * `estorno:<chave da reversão anulada>`, e o `UNIQUE` absorve a mesma anulação
 * vinda do worker ou da F3.
 */
export function excessReversalEstornosOf(
  sale: { readonly skuId: string; readonly qtyDelta: number; readonly idempotencyKey: string },
  reversals: readonly TimedRecordedReversal[],
): StockMovementDraft[] {
  return excessReversalShares(sale, reversals).map((share) => ({
    skuId: sale.skuId,
    // O sinal da venda: a reversão devolveu unidade, a anulação a tira de novo.
    qtyDelta: sale.qtyDelta < 0 ? -share.quantity : share.quantity,
    idempotencyKey: estornoKeyOf(share.reversal.idempotencyKey),
    occurredAt: share.reversal.occurredAt,
  }));
}

export function computeSaleDeductions(order: SaleDeductionOrder, preCapture: PreCaptureCutoffs): SaleDeductionResult {
  if (!isValidSaleStatus(order.status)) {
    return { deductions: [], preCaptureReversals: [], excessReversalEstornos: [] };
  }

  const saleAt = saleInstant(order);
  const deductions: StockMovementDraft[] = [];

  for (const item of order.items) {
    if (item.skuId === null) {
      // Item ainda sem vínculo: nada a deduzir. Resolve sozinho quando o
      // vínculo nascer e a order for reprocessada (D-020, sku_id gravado
      // fresco a cada persistência).
      continue;
    }

    if (item.skuKind === "KIT") {
      for (const component of item.components) {
        deductions.push({
          skuId: component.componentSkuId,
          qtyDelta: -(item.quantity * component.quantity),
          idempotencyKey: `venda:${String(order.id)}:${String(item.position)}:${component.componentSkuId}`,
          occurredAt: saleAt,
        });
      }

      continue;
    }

    deductions.push({
      skuId: item.skuId,
      qtyDelta: -item.quantity,
      idempotencyKey: `venda:${String(order.id)}:${String(item.position)}`,
      occurredAt: saleAt,
    });
  }

  const preCaptureReversals: StockMovementDraft[] = [];
  const excessReversalEstornos: StockMovementDraft[] = [];

  for (const deduction of deductions) {
    const estorno = preCaptureEstornoOf(deduction, saleAt, preCapture);

    if (estorno !== null) {
      preCaptureReversals.push(estorno);
      // A reversão a mais sai com o estorno: sem ele, a venda não é estornada e o
      // excesso fica como estava (o legado que a D-351 não compensa).
      excessReversalEstornos.push(
        ...excessReversalEstornosOf(
          { skuId: estorno.skuId, qtyDelta: -estorno.qtyDelta, idempotencyKey: deduction.idempotencyKey },
          preCapture.recordedReversals,
        ),
      );
    }
  }

  return { deductions, preCaptureReversals, excessReversalEstornos };
}
