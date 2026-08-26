import type { AdminClient } from "@sb/db";
import type { StockMovementDraft } from "@sb/domain";
import type { Logger } from "@sb/observability";

/**
 * Grava os rascunhos de dedução de estoque produzidos por
 * `computeSaleDeductions` (`@sb/domain/inventory`) em `stock_movements`.
 *
 * Best-effort DE PROPÓSITO, mesmo padrão de `domain-events.ts`: falhar aqui
 * não pode derrubar uma persistência de pedido que já deu certo. O
 * conflito de `idempotency_key` não é erro: é a garantia física do ledger
 * funcionando (docs/DATABASE.md secao 3) — reprocessar o mesmo pedido não
 * deduz o estoque duas vezes.
 *
 * **`ON CONFLICT DO NOTHING`, não `INSERT` com o 23505 absorvido no cliente**
 * (D-092). A versão anterior deixava o Postgres REJEITAR cada inserção
 * repetida, e cada rejeição virava uma linha ERROR no log do banco. Como a
 * reconciliação horária reprocessa a mesma janela de pedidos, isso produzia
 * ~9.800 ERROS por dia — todos esperados, todos inúteis, e juntos capazes de
 * enterrar um erro de verdade. A garantia não mudou: a constraint UNIQUE
 * continua existindo e continua sendo o que torna a dupla movimentação
 * fisicamente impossível. O que mudou é o Postgres pular em silêncio em vez
 * de gritar.
 */

const UNIQUE_VIOLATION = "23505";

export interface RecordStockMovementsContext {
  organizationId: string;
}

export async function recordStockMovements(
  db: AdminClient,
  context: RecordStockMovementsContext,
  drafts: readonly StockMovementDraft[],
  movementType: string,
  source: { type: string; id: string },
  logger: Logger,
): Promise<void> {
  for (const draft of drafts) {
    const result = await db.from("stock_movements").upsert(
      {
        organization_id: context.organizationId,
        sku_id: draft.skuId,
        location_kind: draft.locationKind ?? "LOCAL",
        qty_delta: draft.qtyDelta,
        movement_type: movementType,
        source_type: source.type,
        source_id: source.id,
        idempotency_key: draft.idempotencyKey,
        occurred_at: draft.occurredAt.toISOString(),
      },
      // `ignoreDuplicates` = DO NOTHING, nunca DO UPDATE: `stock_movements` é
      // append-only (D-019), e reescrever um movimento existente seria
      // exatamente o que o ledger existe para impedir.
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    );

    // A checagem de 23505 fica como rede: `onConflict` cobre a UNIQUE de
    // `idempotency_key`, mas uma constraint futura não coberta por ela ainda
    // chegaria aqui, e continuaria não sendo motivo para derrubar o job.
    if (result.error !== null && result.error.code !== UNIQUE_VIOLATION) {
      logger.error("stock_movement_not_recorded", {
        sku_id: draft.skuId,
        idempotency_key: draft.idempotencyKey,
        reason: result.error.message,
      });
    }
  }
}
