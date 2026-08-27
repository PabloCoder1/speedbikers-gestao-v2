import type { AdminClient } from "@sb/db";
import { computeReturnReversal } from "@sb/domain";
import type { RecordedSaleMovement } from "@sb/domain";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";

import type { ParsedClaim } from "./claim-schema.js";
import { claimReturnSchema, claimSchema } from "./claim-schema.js";
import { mapClaimToSupportProjection } from "./claim-support-projection.js";
import { recordDomainEvents } from "./domain-events.js";
import { persistSupportClaim } from "./persist-support-claim.js";
import { recordStockMovements } from "./stock-movements.js";

/**
 * Pós-venda (Claims/Returns, D-057) — chamado pelo Fast Path do webhook
 * (`webhook-received.ts`) quando `topic = post_purchase`.
 *
 * Busca o claim, confirma que há devolução física associada
 * (`related_entities` contém `"return"` — mecanismo recomendado na própria
 * documentação oficial, `docs/MERCADO_LIVRE.md` secao 2.10), busca a
 * devolução e, quando `status = "delivered"` (produto de volta fisicamente,
 * não só dinheiro), reverte o estoque do item devolvido —
 * `computeReturnReversal`, puro, em `@sb/domain/inventory`.
 *
 * Reprocessar a mesma notificação (reenvio do Mercado Livre, corrida do
 * Cloud Tasks) é seguro: tudo aqui é releitura do estado atual + chaves
 * determinísticas — nenhum estado é assumido entre chamadas.
 */

export interface ProcessClaimReturnDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
}

export interface ProcessClaimReturnContext {
  organizationId: string;
  mlAccountId: string;
}

async function loadSaleMovements(
  db: AdminClient,
  organizationId: string,
  orderId: number,
): Promise<RecordedSaleMovement[]> {
  const result = await db
    .from("stock_movements")
    .select("sku_id, qty_delta, idempotency_key")
    .eq("organization_id", organizationId)
    .eq("source_type", "ORDER")
    .eq("source_id", String(orderId))
    .eq("movement_type", "VENDA_ML");

  if (result.error !== null) {
    // Não tratar como "nenhum movimento": a devolução física reverteria
    // zero, o estoque devolvido nunca voltaria pro saldo.
    throw new Error(`falha ao ler stock_movements da order ${String(orderId)}: ${result.error.message}`);
  }

  return result.data.map((row) => ({
    skuId: row.sku_id,
    qtyDelta: row.qty_delta,
    idempotencyKey: row.idempotency_key,
  }));
}

/** Mesma forma de `resolveSku` em `persist-order.ts`: `variation_id` nulo precisa de `.is()`, não `.eq()`. */
async function loadOrderItemPosition(
  db: AdminClient,
  orderId: number,
  itemId: string,
  variationId: string | null,
): Promise<number | null> {
  const query = db.from("order_items").select("position").eq("order_id", orderId).eq("item_id", itemId);

  const filtered = variationId === null ? query.is("variation_id", null) : query.eq("variation_id", variationId);

  const result = await filtered.maybeSingle();

  if (result.error !== null) {
    // Não tratar como "item não encontrado" (que vira `continue`, silencioso
    // por natureza): uma devolução física real ficaria sem reversão de
    // estoque por causa de uma falha transitória, indistinguível de "não
    // achou o item".
    throw new Error(
      `falha ao ler order_items (order ${String(orderId)}, item ${itemId}): ${result.error.message}`,
    );
  }

  return result.data?.position ?? null;
}

/**
 * Projeta o claim na Caixa de Entrada (D-104).
 *
 * **Nunca derruba a reversão de estoque.** Esta função roda dentro de um
 * handler cujo trabalho original é financeiro e já está em produção desde
 * D-057; uma falha ao projetar o atendimento (ou um claim sem carimbo de
 * tempo do Mercado Livre) não pode impedir o estoque de voltar. A falha é
 * registrada e a próxima notificação do mesmo claim reprocessa tudo, porque
 * a persistência é idempotente.
 *
 * O inverso não vale: falha de ESTOQUE continua propagando e sendo repetida
 * pelo Cloud Tasks, como sempre foi.
 */
async function projectClaimAsSupportCase(
  db: AdminClient,
  context: ProcessClaimReturnContext,
  claim: ParsedClaim,
  logger: Logger,
): Promise<void> {
  const projection = mapClaimToSupportProjection(claim);

  if (projection === null) {
    logger.warn("claim_support_projection_skipped_without_timestamp", {
      claim_id: String(claim.id),
      reason: "claim sem date_created nem last_updated",
    });

    return;
  }

  try {
    const result = await persistSupportClaim(db, { ...context, source: "WEBHOOK" }, projection);

    logger.info("claim_support_case_persisted", {
      claim_id: String(claim.id),
      support_case_id: result.supportCaseId,
      link_mode: result.linkMode,
      transition_applied: result.transitionApplied,
      is_mediation: projection.case.isMediation,
      has_return: projection.case.hasReturn,
    });
  } catch (error) {
    logger.error("claim_support_projection_failed", {
      claim_id: String(claim.id),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function processClaimReturn(
  deps: ProcessClaimReturnDeps,
  context: ProcessClaimReturnContext,
  accessToken: string,
  claimId: string,
  now: Date,
  logger: Logger,
): Promise<number> {
  const claim = await deps.mercadoLivre.request({
    method: "GET",
    path: `/post-purchase/v1/claims/${claimId}`,
    accessToken,
    schema: claimSchema,
  });

  // D-104 — a projeção de atendimento vem ANTES dos early returns abaixo, e a
  // ordem é o ponto todo: uma reclamação SEM devolução (mediação, disputa de
  // pagamento) é justamente o que a Caixa de Entrada precisa mostrar. Colocar
  // isto depois entregaria só os claims que já reverteram estoque.
  await projectClaimAsSupportCase(deps.db, context, claim, logger);

  if (claim.resource !== "order" || !claim.related_entities.includes("return")) {
    // Reclamação sem devolução física associada (mediação de pagamento,
    // disputa ainda sem devolução, etc.) — nada a fazer aqui ainda; se uma
    // devolução nascer depois, uma nova notificação (claims_actions) chega.
    return 0;
  }

  const claimReturn = await deps.mercadoLivre.request({
    method: "GET",
    path: `/post-purchase/v2/claims/${claimId}/returns`,
    accessToken,
    schema: claimReturnSchema,
  });

  if (claimReturn.status !== "delivered") {
    // Devolução em andamento (pending/shipped/etc.) — reverter agora
    // arriscaria estornar um produto que nunca voltou fisicamente. A
    // próxima notificação de mudança de status reprocessa.
    return 0;
  }

  let processed = 0;

  for (const returnedOrder of claimReturn.orders) {
    const variationId = returnedOrder.variation_id != null ? String(returnedOrder.variation_id) : null;

    const position = await loadOrderItemPosition(deps.db, returnedOrder.order_id, returnedOrder.item_id, variationId);

    if (position === null) {
      logger.warn("claim_return_order_item_not_found", {
        claim_id: claimId,
        order_id: returnedOrder.order_id,
        item_id: returnedOrder.item_id,
      });

      continue;
    }

    const saleMovements = await loadSaleMovements(deps.db, context.organizationId, returnedOrder.order_id);

    const reversal = computeReturnReversal(
      { id: returnedOrder.order_id },
      { position, totalQuantity: returnedOrder.total_quantity, returnQuantity: returnedOrder.return_quantity },
      saleMovements,
      claimId,
      now,
    );

    if (reversal.movements.length > 0) {
      await recordStockMovements(
        deps.db,
        { organizationId: context.organizationId },
        reversal.movements,
        "DEVOLUCAO_ML",
        { type: "CLAIM", id: claimId },
        logger,
      );
    }

    await recordDomainEvents(deps.db, context, [reversal.event], logger);

    if (!reversal.fullReversal) {
      logger.warn("claim_return_needs_manual_review", {
        claim_id: claimId,
        order_id: returnedOrder.order_id,
        position,
        return_quantity: returnedOrder.return_quantity,
        total_quantity: returnedOrder.total_quantity,
      });
    }

    processed += 1;
  }

  return processed;
}
