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
 */

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
   * `erp_stock_snapshots.captured_at` — o instante da EXPORTAÇÃO da planilha.
   * Venda com "venda em" até aqui já está no saldo do ERP.
   */
  readonly capturedAt: Date;
  /**
   * Quando a V3 recebeu esse corte: o menor `created_at` dos snapshots que o
   * definem. Venda gravada até aqui já estava no saldo quando o corte chegou, e
   * não é estornada.
   */
  readonly importedAt: Date;
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
}

export interface SaleDeductionResult {
  readonly deductions: StockMovementDraft[];
  /** Movimentos `ESTORNO_PRE_CAPTURA`, um por dedução anterior ou igual ao corte. */
  readonly preCaptureReversals: StockMovementDraft[];
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
 * O `ESTORNO_PRE_CAPTURA` de uma venda — o rascunho novo ou a linha já gravada
 * com a mesma chave —, ou `null` quando ela não é estornada.
 *
 * Estorna quando a "venda em" é até o corte do SKU E a venda entra no saldo
 * depois de o corte chegar: o rascunho novo sempre (vai ser gravado agora); a
 * linha gravada, só se `recordedAt > importedAt`. Compartilhada com o
 * cancelamento (`computeCancellationMovements`), que precisa do mesmo par.
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

  if (cutoff === null || saleAt.getTime() > cutoff.capturedAt.getTime()) {
    return null;
  }

  if (recorded !== undefined && recorded.recordedAt.getTime() <= cutoff.importedAt.getTime()) {
    // Gravada antes de a planilha chegar: o alvo já a absorveu (ALTA-1).
    return null;
  }

  return {
    skuId: base.skuId,
    qtyDelta: -base.qtyDelta,
    idempotencyKey: estornoKeyOf(sale.idempotencyKey),
    occurredAt: base.occurredAt,
  };
}

export function computeSaleDeductions(order: SaleDeductionOrder, preCapture: PreCaptureCutoffs): SaleDeductionResult {
  if (!isValidSaleStatus(order.status)) {
    return { deductions: [], preCaptureReversals: [] };
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

  for (const deduction of deductions) {
    const estorno = preCaptureEstornoOf(deduction, saleAt, preCapture);

    if (estorno !== null) {
      preCaptureReversals.push(estorno);
    }
  }

  return { deductions, preCaptureReversals };
}
