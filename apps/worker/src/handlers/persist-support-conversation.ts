import type { AdminClient, TablesInsert, TablesUpdate } from "@sb/db";
import type { SupportConversationProjection } from "@sb/mercado-livre";

export interface PersistSupportConversationContext {
  organizationId: string;
  mlAccountId: string;
}

export interface PersistSupportConversationResult {
  supportCaseId: string;
  messagesUpserted: number;
  linkedOrderIds: number[];
  linkMode: "EXTERNAL" | "TYPED";
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
 * Persiste a projeção de uma conversa pós-venda, sem rede/job/webhook.
 *
 * Gêmea de `persistSupportQuestion` (D-086) e pelos mesmos motivos: o primeiro
 * UPSERT usa `ignoreDuplicates` para criar os campos internos sem NUNCA
 * sobrescrevê-los, e o UPDATE seguinte toca somente a projeção remota. Uma
 * triagem humana concorrente (D-094) não é atropelada por uma sincronização.
 *
 * A diferença de canal aparece no vínculo: a Pergunta se liga a um anúncio, a
 * conversa se liga a PEDIDOS — e um pack pode ter vários. Por isso a lista.
 */
export async function persistSupportConversation(
  db: AdminClient,
  context: PersistSupportConversationContext,
  projection: SupportConversationProjection,
): Promise<PersistSupportConversationResult> {
  const caseRow: TablesInsert<"support_cases"> = {
    organization_id: context.organizationId,
    ml_account_id: context.mlAccountId,
    channel: projection.case.channel,
    external_case_key: projection.case.externalCaseKey,
    external_case_id: projection.case.externalCaseId,
    pack_id: projection.case.packId,
    external_status: projection.case.externalStatus,
    external_substatus: projection.case.externalSubstatus,
    external_stage: null,
    external_type: null,
    is_mediation: false,
    has_return: false,
    customer_external_id: projection.case.customerExternalId,
    conversation_path: projection.case.conversationPath,
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
    pack_id: projection.case.packId,
    external_status: projection.case.externalStatus,
    external_substatus: projection.case.externalSubstatus,
    customer_external_id: projection.case.customerExternalId,
    conversation_path: projection.case.conversationPath,
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

  if (projection.messages.length > 0) {
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
  }

  // Um pack agrupa VÁRIOS pedidos (`orders.pack_id`); um pedido avulso é ele
  // mesmo. Nos dois casos o vínculo útil para a operação é o pedido.
  const ordersQuery = db
    .from("orders")
    .select("id")
    .eq("organization_id", context.organizationId)
    .eq("ml_account_id", context.mlAccountId);
  const orders =
    projection.case.packId === null
      ? await ordersQuery.eq("id", Number(projection.case.externalCaseId))
      : await ordersQuery.eq("pack_id", projection.case.packId);

  if (orders.error !== null) {
    throw persistenceError(`resolver pedidos do case ${supportCaseId}`, orders.error);
  }

  const externalEntityKind = projection.case.packId === null ? "ORDER" : "PACK";

  if (orders.data.length === 0) {
    // A conversa pode chegar antes de o pedido ter sido sincronizado. O
    // fallback externo mantém o case rastreável até o pedido existir.
    await insertSupportLink(db, {
      organization_id: context.organizationId,
      ml_account_id: context.mlAccountId,
      support_case_id: supportCaseId,
      external_entity_kind: externalEntityKind,
      external_entity_id: projection.case.externalCaseId,
      link_source: "REMOTE",
    });

    return { supportCaseId, messagesUpserted: projection.messages.length, linkedOrderIds: [], linkMode: "EXTERNAL" };
  }

  for (const order of orders.data) {
    await insertSupportLink(db, {
      organization_id: context.organizationId,
      ml_account_id: context.mlAccountId,
      support_case_id: supportCaseId,
      order_id: order.id,
      link_source: "ORDER_DERIVED",
    });
  }

  // Só depois de o vínculo tipado estar garantido. Remover antes deixaria uma
  // janela em que o case não aponta para lugar nenhum.
  const staleExternalLink = await db
    .from("support_case_links")
    .delete()
    .eq("organization_id", context.organizationId)
    .eq("ml_account_id", context.mlAccountId)
    .eq("support_case_id", supportCaseId)
    .eq("external_entity_kind", externalEntityKind)
    .eq("external_entity_id", projection.case.externalCaseId);

  if (staleExternalLink.error !== null) {
    throw persistenceError(`limpar fallback externo do case ${supportCaseId}`, staleExternalLink.error);
  }

  return {
    supportCaseId,
    messagesUpserted: projection.messages.length,
    linkedOrderIds: orders.data.map((order) => order.id),
    linkMode: "TYPED",
  };
}
