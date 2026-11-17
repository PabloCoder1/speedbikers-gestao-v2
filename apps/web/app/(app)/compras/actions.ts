"use server";

import type { Json } from "@sb/db";
import { revalidatePath } from "next/cache";

import { createClient } from "../../../lib/supabase/server";
import { currentMembership } from "../../../lib/membership";

/**
 * Pedidos de compra (Fase 4, docs/ROADMAP.md).
 *
 * Server Actions (D-012, docs/ARCHITECTURE.md secao 4): escrita chamando as
 * RPCs `security definer` (`supabase/migrations/20260822234353_create_purchasing.sql`)
 * — toda decisão de autorização e a atomicidade (pedido + itens + evento na
 * mesma transação) vivem dentro delas, mesmo padrão de `notas-fiscais/actions.ts`.
 *
 * `exactOptionalPropertyTypes` + o gerador de tipos da RPC (nunca infere
 * `| null` num parâmetro, só opcionalidade via `DEFAULT` no SQL): todo
 * campo opcional é OMITIDO quando nulo, nunca `p_x: null` — mesma lição já
 * aplicada em `notas-fiscais/actions.ts`. `omit()` abaixo centraliza isso.
 */

export interface ActionResult {
  ok: boolean;
  message: string | null;
}

export interface PurchaseOrderItemInput {
  skuId: string | null;
  skuSnapshot: string;
  titleSnapshot: string | null;
  quantityOrdered: number;
  unitCost: number | null;
  /** D-722: a recomendação da avaliação no momento de salvar e a decisão do comprador. */
  recommendedQuantity?: number | null;
  reviewRecommendation?: string | null;
  reviewDecision?: string | null;
  reviewReason?: string | null;
  reviewNote?: string | null;
}

/** Uma decisão do histórico de revisão (D-722), inclusive de item retirado. */
export interface PurchaseOrderReviewInput {
  skuId: string | null;
  skuSnapshot: string;
  recommendation: string;
  decision: string;
  quantityBefore: number;
  quantityAfter: number;
  recommendedQuantity: number | null;
  reason: string | null;
  note: string | null;
  unitCost: number | null;
}

export interface PurchaseOrderDraftInput {
  supplierId: string | null;
  destinationWarehouseName: string | null;
  currency: string | null;
  notes: string | null;
  expectedAt: string | null;
  items: PurchaseOrderItemInput[];
  review?: PurchaseOrderReviewInput[];
  /** D-722: identificador da criação, gerado no navegador — o duplo envio devolve o mesmo pedido. */
  requestId?: string | null;
  /** D-722: o `updated_at` que a edição leu; outra pessoa salvou no meio = recusa. */
  expectedUpdatedAt?: string | null;
}

/** `value` nulo/vazio: chave omitida. Só assim um parâmetro RPC opcional aceita "sem valor". */
function omit<T extends string>(key: T, value: string | null): Record<T, string> | Record<string, never> {
  return value === null || value === "" ? {} : ({ [key]: value } as Record<T, string>);
}

function describeRpcError(error: { message: string } | null): string | null {
  if (error === null) return null;

  if (error.message.includes("sem permissao")) {
    return "Você não tem permissão para operar pedidos de compra — só ADMIN e GESTOR podem.";
  }

  if (error.message.includes("nao esta em rascunho")) {
    return "Este pedido já saiu de rascunho — não é mais possível editar os itens.";
  }

  if (error.message.includes("nao esta aprovado")) {
    return "Este pedido ainda não foi aprovado.";
  }

  if (error.message.includes("nao esta em transito")) {
    return "Este pedido ainda não foi marcado como enviado pelo fornecedor.";
  }

  if (error.message.includes("ja esta em estado terminal")) {
    return "Este pedido já foi recebido ou cancelado — não é mais possível alterá-lo.";
  }

  if (error.message.includes("outra organizacao")) {
    return "Esse fornecedor pertence a outra organização.";
  }

  if (error.message.includes("ao menos um item")) {
    return "Adicione ao menos um item antes de salvar.";
  }

  if (error.message.includes("alterado por outra pessoa")) {
    return "Outra pessoa salvou este rascunho enquanto você editava. Recarregue para ver a versão atual antes de salvar.";
  }

  if (error.message.includes("acima do pedido")) {
    return "A quantidade recebida passa do que falta chegar neste item.";
  }

  if (error.message.includes("informe ao menos uma quantidade")) {
    return "Informe ao menos uma quantidade recebida.";
  }

  if (error.message.includes("nao vale para pedido")) {
    return "Essa etapa não vale para a situação atual do pedido.";
  }

  if (error.message.includes("sku pertence a outra organizacao")) {
    return "Um dos SKUs pertence a outra organização.";
  }

  if (error.message.includes("nao encontrado")) {
    return "Registro não encontrado.";
  }

  return "Não foi possível concluir a ação.";
}

async function currentOrganizationId(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ organizationId: string | null; failed: boolean }> {
  const membership = await currentMembership(supabase);

  if (membership.error !== null) {
    // Distinto de "sem organização" — falha de leitura transitória, não
    // problema de cadastro (D-067, Nível 3).
    return { organizationId: null, failed: true };
  }

  return { organizationId: membership.organizationId, failed: false };
}

function itemsToJsonb(items: readonly PurchaseOrderItemInput[]): Json {
  return items.map((item) => ({
    skuId: item.skuId,
    skuSnapshot: item.skuSnapshot,
    titleSnapshot: item.titleSnapshot,
    quantityOrdered: item.quantityOrdered,
    unitCost: item.unitCost,
    recommendedQuantity: item.recommendedQuantity ?? null,
    reviewRecommendation: item.reviewRecommendation ?? null,
    reviewDecision: item.reviewDecision ?? null,
    reviewReason: item.reviewReason ?? null,
    reviewNote: item.reviewNote ?? null,
  })) satisfies Json;
}

/** O histórico de revisão só vai quando há decisão: sem ela, o parâmetro nem é enviado. */
function comRevisao(review: readonly PurchaseOrderReviewInput[] | undefined): { p_review: Json } | Record<string, never> {
  if (review === undefined || review.length === 0) return {};

  return { p_review: review.map((r) => ({ ...r })) satisfies Json };
}

export async function createPurchaseOrder(
  input: PurchaseOrderDraftInput,
): Promise<ActionResult & { id?: string }> {
  const supabase = await createClient();
  const { organizationId, failed } = await currentOrganizationId(supabase);

  if (failed) {
    return { ok: false, message: "Não foi possível confirmar sua organização — tente de novo." };
  }

  if (organizationId === null) {
    return { ok: false, message: "Sua conta não está associada a nenhuma organização." };
  }

  const { data, error } = await supabase.rpc("create_purchase_order", {
    p_organization_id: organizationId,
    p_items: itemsToJsonb(input.items),
    ...omit("p_supplier_id", input.supplierId),
    ...omit("p_destination_warehouse_name", input.destinationWarehouseName),
    ...omit("p_currency", input.currency),
    ...omit("p_notes", input.notes),
    ...omit("p_expected_at", input.expectedAt),
    ...omit("p_request_id", input.requestId ?? null),
    ...comRevisao(input.review),
  });

  const message = describeRpcError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath("/compras");

  return { ok: true, message: null, ...(data?.id !== undefined ? { id: data.id } : {}) };
}

export async function updatePurchaseOrderDraft(id: string, input: PurchaseOrderDraftInput): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("update_purchase_order_draft", {
    p_id: id,
    p_items: itemsToJsonb(input.items),
    ...omit("p_supplier_id", input.supplierId),
    ...omit("p_destination_warehouse_name", input.destinationWarehouseName),
    ...omit("p_currency", input.currency),
    ...omit("p_notes", input.notes),
    ...omit("p_expected_at", input.expectedAt),
    ...omit("p_expected_updated_at", input.expectedUpdatedAt ?? null),
    ...comRevisao(input.review),
  });

  const message = describeRpcError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath(`/compras/${id}`);

  return { ok: true, message: null };
}

export async function approvePurchaseOrder(id: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("approve_purchase_order", { p_id: id });

  const message = describeRpcError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath(`/compras/${id}`);

  return { ok: true, message: null };
}

export async function markPurchaseOrderOrdered(id: string, expectedAt: string | null): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("mark_purchase_order_ordered", {
    p_id: id,
    ...omit("p_expected_at", expectedAt),
  });

  const message = describeRpcError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath(`/compras/${id}`);

  return { ok: true, message: null };
}

export async function receivePurchaseOrder(id: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("receive_purchase_order", { p_id: id });

  const message = describeRpcError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath(`/compras/${id}`);

  return { ok: true, message: null };
}

export async function cancelPurchaseOrder(id: string, reason: string | null): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("cancel_purchase_order", {
    p_id: id,
    ...omit("p_reason", reason),
  });

  const message = describeRpcError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath(`/compras/${id}`);

  return { ok: true, message: null };
}

/** D-724: recebe o que chegou, item a item. Idempotente pelo `requestId` gerado no navegador. */
export async function receivePurchaseOrderItems(
  id: string,
  items: readonly { itemId: string; quantity: number }[],
  requestId: string,
): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("receive_purchase_order_items", {
    p_id: id,
    p_items: items.map((i) => ({ itemId: i.itemId, quantity: i.quantity })) satisfies Json,
    p_request_id: requestId,
  });

  const message = describeRpcError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath(`/compras/${id}`);

  return { ok: true, message: null };
}

/** D-725: a etapa logística do pedido, validada pelo status no banco. */
export async function setPurchaseOrderStage(id: string, stage: string | null, note: string | null): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("set_purchase_order_stage", {
    p_id: id,
    p_stage: stage,
    ...omit("p_note", note),
  });

  const message = describeRpcError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath(`/compras/${id}`);

  return { ok: true, message: null };
}

export interface PurchaseOrderCostInput {
  id: string | null;
  kind: string;
  description: string | null;
  amount: number;
  currency: string;
  exchangeRate: number | null;
  status: "ESTIMADO" | "REALIZADO";
}

/** D-725: inclui ou edita um custo adicional do pedido (frete, seguro, tributos...). */
export async function upsertPurchaseOrderCost(purchaseOrderId: string, input: PurchaseOrderCostInput): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("upsert_purchase_order_cost", {
    p_purchase_order_id: purchaseOrderId,
    p_kind: input.kind,
    p_amount: input.amount,
    p_currency: input.currency,
    p_status: input.status,
    ...omit("p_id", input.id),
    ...omit("p_description", input.description),
    ...(input.exchangeRate === null ? {} : { p_exchange_rate: input.exchangeRate }),
  });

  const message = describeRpcError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath(`/compras/${purchaseOrderId}`);

  return { ok: true, message: null };
}

export async function deletePurchaseOrderCost(purchaseOrderId: string, costId: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("delete_purchase_order_cost", { p_id: costId });

  const message = describeRpcError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath(`/compras/${purchaseOrderId}`);

  return { ok: true, message: null };
}
