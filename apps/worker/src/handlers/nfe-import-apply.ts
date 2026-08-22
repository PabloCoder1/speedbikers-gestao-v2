import type { AdminClient } from "@sb/db";
import { computeNfeApplicationMovements } from "@sb/domain";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { recordStockMovements } from "./stock-movements.js";

/**
 * Aplicação da NF-e conferida.
 *
 * Última etapa do fluxo: `upload -> parse -> conferência -> confirmação ->
 * APLICAÇÃO`. Primeiro handler de NF-e que escreve em domínio: gera
 * `stock_movements` (`ENTRADA_NFE`/`SAIDA_NFE`) a partir dos itens já
 * vinculados a um SKU.
 *
 * `confirmNfeApply` (`apps/api/src/nfe-import.ts`) já exigiu 100% dos itens
 * vinculados antes de mover o documento para `APPLYING` — a checagem é
 * repetida aqui (`resolved_items === total_items`) pelo mesmo motivo de
 * dupla checagem já usado nas RPCs `security definer`: cada camada se
 * defende sozinha, não confia cegamente na anterior.
 *
 * Idempotente por construção: reentrega encontra o documento `APPLIED` e sai
 * cedo, sem gerar novo movimento (regra 1 de `docs/TESTING.md`) — e mesmo
 * sem essa checagem, a chave de idempotência de `stock_movements` (`nfe:` +
 * `documentId` + posição) já impediria duplicar o ledger.
 */

const payloadSchema = z.object({ documentId: z.uuid() });

export interface NfeApplyDeps {
  db: AdminClient;
  now?: () => Date;
}

export function createNfeImportApplyHandler(deps: NfeApplyDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem documentId" };
    }

    const { documentId } = parsed.data;

    const document = await deps.db
      .from("documents")
      .select("id, status, organization_id, operation_type, issue_date, total_items, resolved_items")
      .eq("id", documentId)
      .maybeSingle();

    if (document.error !== null) {
      return { status: "failed", retryable: true, reason: document.error.message };
    }

    if (document.data === null) {
      return { status: "failed", retryable: false, reason: `documento ${documentId} não existe` };
    }

    if (document.data.status === "APPLIED") {
      // Reentrega depois de já concluído: nada a fazer.
      return { status: "done", processed: 0 };
    }

    if (document.data.status !== "APPLYING") {
      return {
        status: "failed",
        retryable: false,
        reason: `documento em status ${document.data.status}, não pronto para aplicação`,
      };
    }

    const data = document.data;

    if (data.operation_type === null || data.issue_date === null) {
      // Não deveria acontecer: o parse sempre preenche os dois antes de
      // marcar PARSED, e só um documento PARSED chega a APPLYING.
      return { status: "failed", retryable: false, reason: "documento sem direção ou data de emissão" };
    }

    const total = data.total_items ?? 0;
    const resolved = data.resolved_items ?? 0;

    if (total === 0 || resolved < total) {
      return {
        status: "failed",
        retryable: false,
        reason: `${String(resolved)} de ${String(total)} itens vinculados — confirmação não deveria ter liberado isto`,
      };
    }

    const items = await deps.db
      .from("document_items")
      .select("position, sku_id, quantity")
      .eq("document_id", documentId)
      .order("position");

    if (items.error !== null) {
      return { status: "failed", retryable: true, reason: items.error.message };
    }

    const movements = computeNfeApplicationMovements({
      id: documentId,
      operationType: data.operation_type as "ENTRADA" | "SAIDA",
      occurredAt: new Date(data.issue_date),
      items: items.data.map((item) => ({ position: item.position, skuId: item.sku_id, quantity: item.quantity })),
    });

    await recordStockMovements(
      deps.db,
      { organizationId: data.organization_id },
      movements,
      data.operation_type === "ENTRADA" ? "ENTRADA_NFE" : "SAIDA_NFE",
      { type: "DOCUMENT", id: documentId },
      context.logger,
    );

    await deps.db
      .from("documents")
      .update({ status: "APPLIED", applied_at: (deps.now?.() ?? new Date()).toISOString() })
      .eq("id", documentId);

    context.logger.info("nfe_apply_finished", { document_id: documentId, movements: movements.length });

    return { status: "done", processed: movements.length };
  };
}
