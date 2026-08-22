import type { StockMovementDraft } from "./sale-deduction.js";

/**
 * Aplicação de NF-e — a peça pura de `apps/worker/src/handlers/nfe-import-apply.ts`,
 * chamada na confirmação humana (`docs/ROADMAP.md`, item de NF-e/XML da Fase 4).
 *
 * Só gera movimento para itens JÁ VINCULADOS (`sku_id` não nulo) — o mesmo
 * raciocínio de `computeSaleDeductions`: item sem vínculo não movimenta nada.
 * Diferente da venda, porém, a confirmação da NF-e exige 100% dos itens
 * vinculados antes de chegar aqui (`apps/api/src/nfe-import.ts`,
 * `confirmNfeApply`) — uma nota fiscal é um documento fechado, e aplicar
 * parcialmente representaria estoque físico que chegou/saiu sem registro,
 * silenciosamente. A checagem de completude não é feita aqui de propósito
 * (função pura, sem acesso a `document_items`) — é responsabilidade de quem
 * chama, e é verificada duas vezes (confirmação humana E o próprio handler,
 * mesmo padrão de dupla checagem já usado nas RPCs `security definer`).
 *
 * ENTRADA soma ao estoque (compra de fornecedor); SAIDA subtrai (nota de
 * saída sem venda no Mercado Livre, ex.: devolução a fornecedor, transferência
 * fiscal). `docs/NFE.md` secao 2.2 — a direção já vem decidida por
 * `resolveOperationType` no parse, nunca recalculada aqui.
 */

export interface NfeApplicationItem {
  readonly position: number;
  readonly skuId: string | null;
  readonly quantity: number;
}

export interface NfeApplicationDocument {
  readonly id: string;
  readonly operationType: "ENTRADA" | "SAIDA";
  /** `documents.issue_date` — quando a nota foi emitida, não quando foi aplicada. */
  readonly occurredAt: Date;
  readonly items: readonly NfeApplicationItem[];
}

export function computeNfeApplicationMovements(document: NfeApplicationDocument): StockMovementDraft[] {
  const sign = document.operationType === "ENTRADA" ? 1 : -1;
  const drafts: StockMovementDraft[] = [];

  for (const item of document.items) {
    if (item.skuId === null) {
      continue;
    }

    drafts.push({
      skuId: item.skuId,
      qtyDelta: sign * item.quantity,
      idempotencyKey: `nfe:${document.id}:${String(item.position)}`,
      occurredAt: document.occurredAt,
    });
  }

  return drafts;
}
