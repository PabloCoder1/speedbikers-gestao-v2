import type { AdminClient, TablesInsert, TablesUpdate } from "@sb/db";
import { evaluateClaimRemoteTransition } from "@sb/domain";

import type {
  SupportClaimDeadlineProjection,
  SupportClaimMessageProjection,
  SupportClaimProjection,
} from "./claim-support-projection.js";
import { applyRemoteTransition } from "./persist-support-question.js";

/**
 * Persiste a projeção de um claim como `support_cases` canal `CLAIM` (D-104).
 *
 * Mesma porta idempotente das Perguntas (D-086) e das Conversas (D-097): o
 * primeiro UPSERT usa `ignoreDuplicates` para criar os campos internos sem
 * NUNCA sobrescrevê-los num conflito; o UPDATE seguinte altera só a projeção
 * remota. Triagem humana concorrente sobrevive à re-ingestão (D-084).
 *
 * Mediação e devolução NÃO viram cases próprios — são colunas deste mesmo
 * case (`is_mediation`/`has_return`), como D-084 decidiu. Os filtros
 * "Mediações" e "Devoluções" da Caixa de Entrada podem devolver a mesma
 * linha, e isso é o comportamento correto.
 */

export interface PersistSupportClaimContext {
  organizationId: string;
  mlAccountId: string;
  source: "WEBHOOK" | "RECONCILIATION" | "SYSTEM";
}

export interface PersistSupportClaimResult {
  supportCaseId: string;
  linkMode: "TYPED" | "EXTERNAL" | "NONE";
  transitionApplied: boolean;
  messagesUpserted: number;
  deadlinesUpserted: number;
}

function persistenceError(operation: string, error: { message: string }): Error {
  return new Error(`falha ao ${operation}: ${error.message}`);
}

async function insertSupportLink(db: AdminClient, row: TablesInsert<"support_case_links">): Promise<void> {
  const result = await db.from("support_case_links").insert(row);

  // 23505 = a mesma ligação já existe. Reprocessar a notificação é normal.
  if (result.error !== null && result.error.code !== "23505") {
    throw persistenceError("gravar vínculo do atendimento", result.error);
  }
}

/**
 * `support_case_links.order_id` tem FK real para `orders`. Um claim pode
 * chegar antes do pedido estar sincronizado (ou de um pedido fora da janela
 * de backfill), e aí a FK derrubaria a ingestão inteira do atendimento.
 * Mesma saída já usada para anúncio em D-086: vínculo externo explícito, que
 * uma passada futura promove para tipado.
 */
async function linkOrder(
  db: AdminClient,
  context: PersistSupportClaimContext,
  supportCaseId: string,
  orderId: number,
): Promise<"TYPED" | "EXTERNAL"> {
  const order = await db
    .from("orders")
    .select("id")
    .eq("organization_id", context.organizationId)
    .eq("id", orderId)
    .maybeSingle();

  if (order.error !== null) {
    throw persistenceError(`resolver pedido ${String(orderId)} do claim`, order.error);
  }

  if (order.data === null) {
    await insertSupportLink(db, {
      organization_id: context.organizationId,
      ml_account_id: context.mlAccountId,
      support_case_id: supportCaseId,
      external_entity_kind: "ORDER",
      external_entity_id: String(orderId),
      link_source: "REMOTE",
    });

    return "EXTERNAL";
  }

  await insertSupportLink(db, {
    organization_id: context.organizationId,
    ml_account_id: context.mlAccountId,
    support_case_id: supportCaseId,
    order_id: orderId,
    link_source: "REMOTE",
  });

  // D-116 — deriva o SKU dos ITENS do pedido (`sku_id` resolvido e congelado
  // na persistência da venda, D-020). `ORDER_DERIVED` existia no CHECK desde
  // D-085 e nunca tinha sido usado: sem esta derivação, claim não tem
  // vínculo de SKU nenhum e a detecção de padrões por SKU é estruturalmente
  // vazia (medido: 359 links de pedido, ZERO de SKU). Como a varredura
  // horária re-persiste todo claim ABERTO, o estoque antigo se repara
  // sozinho na próxima passada — sem backfill manual.
  const items = await db
    .from("order_items")
    .select("sku_id")
    .eq("order_id", orderId)
    .not("sku_id", "is", null);

  if (items.error === null) {
    // O `.not("sku_id","is",null)` acima já exclui itens sem vínculo; o
    // types gerado marca a coluna como não-nula e o lint confirma que o
    // filtro extra seria condição morta.
    const skuIds = [...new Set(items.data.map((item) => item.sku_id))];

    for (const skuId of skuIds) {
      await insertSupportLink(db, {
        organization_id: context.organizationId,
        ml_account_id: context.mlAccountId,
        support_case_id: supportCaseId,
        sku_id: skuId,
        link_source: "ORDER_DERIVED",
      });
    }
  }

  // O vínculo externo foi o fallback enquanto o pedido não existia. Só
  // removê-lo depois do tipado estar garantido, nunca antes.
  const staleExternal = await db
    .from("support_case_links")
    .delete()
    .eq("organization_id", context.organizationId)
    .eq("ml_account_id", context.mlAccountId)
    .eq("support_case_id", supportCaseId)
    .eq("external_entity_kind", "ORDER")
    .eq("external_entity_id", String(orderId));

  if (staleExternal.error !== null) {
    throw persistenceError(`limpar fallback externo do case ${supportCaseId}`, staleExternal.error);
  }

  return "TYPED";
}

export async function persistSupportClaim(
  db: AdminClient,
  context: PersistSupportClaimContext,
  projection: SupportClaimProjection,
  messages: readonly SupportClaimMessageProjection[] = [],
  deadlines: readonly SupportClaimDeadlineProjection[] = [],
): Promise<PersistSupportClaimResult> {
  const projected = projection.case;

  const caseRow: TablesInsert<"support_cases"> = {
    organization_id: context.organizationId,
    ml_account_id: context.mlAccountId,
    channel: projected.channel,
    external_case_key: projected.externalCaseKey,
    external_case_id: projected.externalCaseId,
    pack_id: null,
    external_status: projected.externalStatus,
    external_substatus: null,
    external_stage: projected.externalStage,
    external_type: projected.externalType,
    is_mediation: projected.isMediation,
    // `null` (fonte não informou) vira `false` só na CRIAÇÃO: a coluna é
    // `not null` e "não sei" começa como "não sinalizado".
    has_return: projected.hasReturn ?? false,
    customer_external_id: projected.customerExternalId,
    conversation_path: null,
    remote_unread_count: 0,
    remote_reply_state: projected.remoteReplyState,
    remote_reply_block_reason: null,
    internal_status: projected.initialInternalStatus,
    priority: projected.initialPriority,
    assignee_id: null,
    last_activity_at: projected.lastActivityAt,
    last_inbound_at: null,
    last_outbound_at: null,
    resolved_at: projected.initialResolvedAt,
  };

  const caseCreate = await db.from("support_cases").upsert(caseRow, {
    onConflict: "organization_id,ml_account_id,channel,external_case_key",
    ignoreDuplicates: true,
  });

  if (caseCreate.error !== null) {
    throw persistenceError(`criar case ${projected.externalCaseKey}`, caseCreate.error);
  }

  // Só a projeção remota. `internal_status`, `priority`, `assignee_id` e
  // `resolved_at` ficam DE FORA de propósito: são território da triagem
  // humana (D-094) e da transição guardada (D-102), abaixo.
  const remoteUpdate: TablesUpdate<"support_cases"> = {
    external_status: projected.externalStatus,
    external_stage: projected.externalStage,
    external_type: projected.externalType,
    is_mediation: projected.isMediation,
    customer_external_id: projected.customerExternalId,
    remote_reply_state: projected.remoteReplyState,
    last_activity_at: projected.lastActivityAt,
    // `has_return` só entra no UPDATE quando a fonte REALMENTE informou
    // (D-109). A varredura não recebe `related_entities`, e sobrescrever com
    // `false` apagaria a devolução que o webhook já tinha registrado — a
    // reconciliação destruiria o dado que ela existe para proteger.
    ...(projected.hasReturn === null ? {} : { has_return: projected.hasReturn }),
  };

  const caseWrite = await db
    .from("support_cases")
    .update(remoteUpdate)
    .eq("organization_id", context.organizationId)
    .eq("ml_account_id", context.mlAccountId)
    .eq("channel", projected.channel)
    .eq("external_case_key", projected.externalCaseKey)
    .select("id")
    .single();

  if (caseWrite.error !== null) {
    throw persistenceError(`gravar case ${projected.externalCaseKey}`, caseWrite.error);
  }

  const supportCaseId = caseWrite.data.id;

  const transitionApplied = await applyRemoteTransition(
    db,
    context.source,
    supportCaseId,
    evaluateClaimRemoteTransition({
      caseId: supportCaseId,
      remotelyClosed: projected.initialInternalStatus === "RESOLVIDO",
      resolvedAt: projected.initialResolvedAt,
      lastActivityAt: projected.lastActivityAt,
    }),
  );

  const messagesUpserted = await upsertMessages(db, context, supportCaseId, messages);
  const deadlinesUpserted = await upsertDeadlines(db, context, supportCaseId, deadlines);

  if (projection.orderId === null) {
    return { supportCaseId, linkMode: "NONE", transitionApplied, messagesUpserted, deadlinesUpserted };
  }

  const linkMode = await linkOrder(db, context, supportCaseId, projection.orderId);

  return { supportCaseId, linkMode, transitionApplied, messagesUpserted, deadlinesUpserted };
}

/**
 * Prazos do claim, sempre com fonte (D-084).
 *
 * O passo que NÃO é óbvio é o cancelamento: uma ação some de
 * `available_actions` quando deixa de estar disponível — normalmente porque
 * já foi cumprida. Sem cancelar, a linha continuaria `ACTIVE` para sempre e
 * a Caixa de Entrada mostraria um prazo vencido que não existe mais,
 * exatamente o tipo de urgência falsa que a tela existe para evitar.
 *
 * Cancela, nunca apaga: `CANCELLED` preserva que o prazo existiu.
 */
async function upsertDeadlines(
  db: AdminClient,
  context: PersistSupportClaimContext,
  supportCaseId: string,
  deadlines: readonly SupportClaimDeadlineProjection[],
): Promise<number> {
  const stillOpen = deadlines
    .filter((deadline) => deadline.source === "ML_AVAILABLE_ACTION")
    .map((deadline) => deadline.sourceReference)
    .filter((reference): reference is string => reference !== null);

  const staleQuery = db
    .from("support_case_deadlines")
    .update({ status: "CANCELLED" })
    .eq("organization_id", context.organizationId)
    .eq("support_case_id", supportCaseId)
    .eq("source", "ML_AVAILABLE_ACTION")
    .eq("status", "ACTIVE");

  const stale = await (stillOpen.length > 0
    ? staleQuery.not("source_reference", "in", `(${stillOpen.join(",")})`)
    : staleQuery);

  if (stale.error !== null) {
    throw persistenceError(`cancelar prazos vencidos do case ${supportCaseId}`, stale.error);
  }

  if (deadlines.length === 0) {
    return 0;
  }

  const rows: TablesInsert<"support_case_deadlines">[] = deadlines.map((deadline) => ({
    organization_id: context.organizationId,
    ml_account_id: context.mlAccountId,
    support_case_id: supportCaseId,
    deadline_kind: deadline.deadlineKind,
    source: deadline.source,
    source_reference: deadline.sourceReference,
    policy_key: null,
    started_at: deadline.startedAt,
    due_at: deadline.dueAt,
    status: deadline.status,
    met_at: null,
  }));

  const result = await db
    .from("support_case_deadlines")
    .upsert(rows, { onConflict: "support_case_id,deadline_kind,source,source_reference" });

  if (result.error !== null) {
    throw persistenceError(`gravar prazos do case ${supportCaseId}`, result.error);
  }

  return rows.length;
}

/**
 * Transcript do claim. A UNIQUE `(support_case_id, external_message_key)`
 * absorve a re-ingestão; a chave é fingerprint porque o payload não traz ID
 * (ver `buildClaimMessageKey`).
 *
 * **O transcript NUNCA é apagado e reescrito**, só acrescentado/atualizado:
 * a doc oficial filtra em silêncio as mensagens moderadas da contraparte, e
 * um `delete`+`insert` deixaria o histórico ENCOLHER a cada rodada, apagando
 * localmente uma mensagem que existiu de verdade.
 */
async function upsertMessages(
  db: AdminClient,
  context: PersistSupportClaimContext,
  supportCaseId: string,
  messages: readonly SupportClaimMessageProjection[],
): Promise<number> {
  if (messages.length === 0) {
    return 0;
  }

  const rows: TablesInsert<"support_messages">[] = messages.map((message) => ({
    organization_id: context.organizationId,
    ml_account_id: context.mlAccountId,
    support_case_id: supportCaseId,
    external_message_key: message.externalMessageKey,
    external_message_id: null,
    direction: message.direction,
    sender_kind: message.senderKind,
    remote_from_user_id: null,
    remote_to_user_id: null,
    body: message.body,
    body_state: message.bodyState,
    remote_status: message.remoteStatus,
    occurred_at: message.occurredAt,
  }));

  const result = await db
    .from("support_messages")
    .upsert(rows, { onConflict: "support_case_id,external_message_key" });

  if (result.error !== null) {
    throw persistenceError(`gravar transcript do case ${supportCaseId}`, result.error);
  }

  return rows.length;
}
