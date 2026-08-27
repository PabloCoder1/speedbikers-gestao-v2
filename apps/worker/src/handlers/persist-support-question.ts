import type { AdminClient, TablesInsert, TablesUpdate } from "@sb/db";
import { evaluateQuestionRemoteTransition } from "@sb/domain";
import type { SupportRemoteTransition } from "@sb/domain";
import type { SupportQuestionProjection } from "@sb/mercado-livre";

export interface PersistSupportQuestionContext {
  organizationId: string;
  mlAccountId: string;
  /** Origem da ingestão — vira `support_case_events.source` na transição automática (D-102). */
  source: "WEBHOOK" | "RECONCILIATION" | "SYSTEM";
}

export interface PersistSupportQuestionResult {
  supportCaseId: string;
  messagesUpserted: number;
  linkMode: "EXTERNAL" | "TYPED";
  /** D-102: a atividade remota moveu o status interno nesta passada? */
  transitionApplied: boolean;
}

/**
 * Executa a transição automática decidida em `@sb/domain` (D-102) — a RPC
 * faz o UPDATE guardado + `support_case_events` na MESMA transação, e o
 * guard (`p_expected_statuses`) garante que decisão humana nunca é
 * sobrescrita. `false` (guard não bateu) é cenário normal, não erro.
 */
export async function applyRemoteTransition(
  db: AdminClient,
  source: PersistSupportQuestionContext["source"],
  caseId: string,
  transition: SupportRemoteTransition | null,
): Promise<boolean> {
  if (transition === null) {
    return false;
  }

  const result = await db.rpc("apply_support_remote_transition", {
    p_case_id: caseId,
    p_expected_statuses: [...transition.expectedStatuses],
    p_new_status: transition.newStatus,
    p_source: source,
    p_event_type: transition.eventType,
    p_dedup_key: transition.dedupKey,
    p_occurred_at: transition.occurredAt,
  });

  if (result.error !== null) {
    throw persistenceError(`aplicar transição automática do case ${caseId}`, result.error);
  }

  return result.data === true;
}

function persistenceError(operation: string, error: { message: string }): Error {
  return new Error(`falha ao ${operation}: ${error.message}`);
}

async function insertSupportLink(
  db: AdminClient,
  row: TablesInsert<"support_case_links">,
): Promise<void> {
  const result = await db.from("support_case_links").insert(row);

  if (result.error !== null && result.error.code !== "23505") {
    throw persistenceError("gravar vínculo do atendimento", result.error);
  }
}

/**
 * Persiste a projeção de uma Pergunta sem rede/job/webhook.
 *
 * O primeiro UPSERT usa `ignoreDuplicates`: cria os campos internos iniciais,
 * mas nunca os atualiza num conflito. Em seguida o UPDATE altera somente a
 * projeção remota e devolve o ID. Isso preserva status/prioridade/responsável
 * internos inclusive se uma triagem humana ocorrer concorrentemente (D-084).
 *
 * As tabelas são L1 e a integração futura reprocessará o mesmo recurso. Como
 * em `persist-order.ts`, as chamadas entre tabelas não são uma transação única:
 * falha intermediária rejeita o processamento e a próxima entrega converge
 * pelos mesmos UPSERTs/constraints.
 */
export async function persistSupportQuestion(
  db: AdminClient,
  context: PersistSupportQuestionContext,
  projection: SupportQuestionProjection,
): Promise<PersistSupportQuestionResult> {
  const caseRow: TablesInsert<"support_cases"> = {
    organization_id: context.organizationId,
    ml_account_id: context.mlAccountId,
    channel: projection.case.channel,
    external_case_key: projection.case.externalCaseKey,
    external_case_id: projection.case.externalCaseId,
    pack_id: null,
    external_status: projection.case.externalStatus,
    external_substatus: null,
    external_stage: null,
    external_type: null,
    is_mediation: false,
    has_return: false,
    customer_external_id: projection.case.customerExternalId,
    conversation_path: null,
    remote_unread_count: projection.case.remoteUnreadCount,
    remote_reply_state: projection.case.remoteReplyState,
    remote_reply_block_reason: projection.case.remoteReplyBlockReason,
    internal_status: projection.case.initialInternalStatus,
    priority: projection.case.initialPriority,
    assignee_id: null,
    last_activity_at: projection.case.lastActivityAt,
    last_inbound_at: projection.case.lastInboundAt,
    last_outbound_at: projection.case.lastOutboundAt,
    resolved_at: projection.case.initialResolvedAt,
  };

  const caseCreate = await db.from("support_cases").upsert(caseRow, {
    onConflict: "organization_id,ml_account_id,channel,external_case_key",
    ignoreDuplicates: true,
  });

  if (caseCreate.error !== null) {
    throw persistenceError(`criar case ${projection.case.externalCaseKey}`, caseCreate.error);
  }

  const remoteCaseUpdate: TablesUpdate<"support_cases"> = {
    external_case_id: projection.case.externalCaseId,
    external_status: projection.case.externalStatus,
    customer_external_id: projection.case.customerExternalId,
    remote_unread_count: projection.case.remoteUnreadCount,
    remote_reply_state: projection.case.remoteReplyState,
    remote_reply_block_reason: projection.case.remoteReplyBlockReason,
    last_activity_at: projection.case.lastActivityAt,
    last_inbound_at: projection.case.lastInboundAt,
    last_outbound_at: projection.case.lastOutboundAt,
  };

  const caseWrite = await db
    .from("support_cases")
    .update(remoteCaseUpdate)
    .eq("organization_id", context.organizationId)
    .eq("ml_account_id", context.mlAccountId)
    .eq("channel", projection.case.channel)
    .eq("external_case_key", projection.case.externalCaseKey)
    .select("id")
    .single();

  if (caseWrite.error !== null) {
    throw persistenceError(`gravar case ${projection.case.externalCaseKey}`, caseWrite.error);
  }

  const supportCaseId = caseWrite.data.id;

  // D-102: pergunta respondida/encerrada no lado remoto resolve o case que
  // ninguém triou — inclusive quando a resposta veio de fora da V3. Roda em
  // TODA re-ingestão (não só na primeira): é justamente a re-ingestão que
  // traz a resposta dada pelo app do Mercado Livre.
  const transitionApplied = await applyRemoteTransition(
    db,
    context.source,
    supportCaseId,
    evaluateQuestionRemoteTransition({
      caseId: supportCaseId,
      remotelyResolved: projection.case.initialInternalStatus === "RESOLVIDO",
      resolvedAt: projection.case.initialResolvedAt,
      lastActivityAt: projection.case.lastActivityAt,
    }),
  );

  const messageRows: TablesInsert<"support_messages">[] = projection.messages.map((message) => ({
    organization_id: context.organizationId,
    ml_account_id: context.mlAccountId,
    support_case_id: supportCaseId,
    external_message_key: message.externalMessageKey,
    external_message_id: message.externalMessageId,
    direction: message.direction,
    sender_kind: message.senderKind,
    remote_from_user_id: message.remoteFromUserId,
    remote_to_user_id: message.remoteToUserId,
    body: message.body,
    body_state: message.bodyState,
    remote_status: message.remoteStatus,
    occurred_at: message.occurredAt,
    observed_at: message.observedAt,
  }));

  const messagesWrite = await db.from("support_messages").upsert(messageRows, {
    onConflict: "support_case_id,external_message_key",
  });

  if (messagesWrite.error !== null) {
    throw persistenceError(`gravar mensagens do case ${supportCaseId}`, messagesWrite.error);
  }

  const listing = await db
    .from("listings")
    .select("id, sku_id")
    .eq("organization_id", context.organizationId)
    .eq("ml_account_id", context.mlAccountId)
    .eq("item_id", projection.listingItemId)
    .maybeSingle();

  if (listing.error !== null) {
    throw persistenceError(`resolver anúncio ${projection.listingItemId}`, listing.error);
  }

  if (listing.data === null) {
    await insertSupportLink(db, {
      organization_id: context.organizationId,
      ml_account_id: context.mlAccountId,
      support_case_id: supportCaseId,
      external_entity_kind: "LISTING",
      external_entity_id: projection.listingItemId,
      link_source: "REMOTE",
    });

    return { supportCaseId, messagesUpserted: messageRows.length, linkMode: "EXTERNAL", transitionApplied };
  }

  await insertSupportLink(db, {
    organization_id: context.organizationId,
    ml_account_id: context.mlAccountId,
    support_case_id: supportCaseId,
    listing_id: listing.data.id,
    link_source: "REMOTE",
  });

  // Um vínculo de listing pode ser corrigido depois. Para QUESTION há um item
  // remoto só; remover apenas os SKUs derivados evita deixar filtro apontando
  // para o SKU antigo, sem tocar em link MANUAL.
  const staleSkuLinks = await db
    .from("support_case_links")
    .delete()
    .eq("organization_id", context.organizationId)
    .eq("ml_account_id", context.mlAccountId)
    .eq("support_case_id", supportCaseId)
    .eq("link_source", "LISTING_DERIVED");

  if (staleSkuLinks.error !== null) {
    throw persistenceError(`limpar vínculo de SKU derivado do case ${supportCaseId}`, staleSkuLinks.error);
  }

  if (listing.data.sku_id !== null) {
    await insertSupportLink(db, {
      organization_id: context.organizationId,
      ml_account_id: context.mlAccountId,
      support_case_id: supportCaseId,
      sku_id: listing.data.sku_id,
      link_source: "LISTING_DERIVED",
    });
  }

  // O item externo foi o fallback enquanto `listings` ainda não possuía a
  // linha. Só removê-lo depois de o vínculo tipado estar garantido.
  const staleExternalLink = await db
    .from("support_case_links")
    .delete()
    .eq("organization_id", context.organizationId)
    .eq("ml_account_id", context.mlAccountId)
    .eq("support_case_id", supportCaseId)
    .eq("external_entity_kind", "LISTING")
    .eq("external_entity_id", projection.listingItemId);

  if (staleExternalLink.error !== null) {
    throw persistenceError(`limpar fallback externo do case ${supportCaseId}`, staleExternalLink.error);
  }

  return { supportCaseId, messagesUpserted: messageRows.length, linkMode: "TYPED", transitionApplied };
}
