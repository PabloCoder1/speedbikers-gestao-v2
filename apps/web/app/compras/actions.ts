"use server";

import type { Json } from "@sb/db";
import { revalidatePath } from "next/cache";

import { createClient } from "../../lib/supabase/server";

/**
 * Fornecedores e pedidos de compra (Fase 4, docs/ROADMAP.md).
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
}

export interface SupplierInput {
  name: string;
  legalName: string | null;
  document: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  website: string | null;
  notes: string | null;
}

export interface PurchaseOrderDraftInput {
  supplierId: string | null;
  destinationWarehouseName: string | null;
  currency: string | null;
  notes: string | null;
  expectedAt: string | null;
  items: PurchaseOrderItemInput[];
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

  if (error.message.includes("nao encontrado")) {
    return "Registro não encontrado.";
  }

  return "Não foi possível concluir a ação.";
}

async function currentOrganizationId(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ organizationId: string | null; failed: boolean }> {
  const membership = await supabase.from("organization_members").select("organization_id").maybeSingle();

  if (membership.error !== null) {
    // Distinto de "sem organização" — falha de leitura transitória, não
    // problema de cadastro (D-067, Nível 3).
    return { organizationId: null, failed: true };
  }

  return { organizationId: membership.data?.organization_id ?? null, failed: false };
}

export async function createSupplier(input: SupplierInput): Promise<ActionResult & { id?: string }> {
  const supabase = await createClient();
  const { organizationId, failed } = await currentOrganizationId(supabase);

  if (failed) {
    return { ok: false, message: "Não foi possível confirmar sua organização — tente de novo." };
  }

  if (organizationId === null) {
    return { ok: false, message: "Sua conta não está associada a nenhuma organização." };
  }

  const { data, error } = await supabase.rpc("create_supplier", {
    p_organization_id: organizationId,
    p_name: input.name,
    ...omit("p_legal_name", input.legalName),
    ...omit("p_document", input.document),
    ...omit("p_contact_name", input.contactName),
    ...omit("p_email", input.email),
    ...omit("p_phone", input.phone),
    ...omit("p_whatsapp", input.whatsapp),
    ...omit("p_website", input.website),
    ...omit("p_notes", input.notes),
  });

  const message = describeRpcError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath("/fornecedores");

  return { ok: true, message: null, ...(data?.id !== undefined ? { id: data.id } : {}) };
}

export async function updateSupplier(id: string, input: SupplierInput & { isActive: boolean }): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("update_supplier", {
    p_id: id,
    p_name: input.name,
    p_is_active: input.isActive,
    ...omit("p_legal_name", input.legalName),
    ...omit("p_document", input.document),
    ...omit("p_contact_name", input.contactName),
    ...omit("p_email", input.email),
    ...omit("p_phone", input.phone),
    ...omit("p_whatsapp", input.whatsapp),
    ...omit("p_website", input.website),
    ...omit("p_notes", input.notes),
  });

  const message = describeRpcError(error);

  if (message !== null) {
    return { ok: false, message };
  }

  revalidatePath("/fornecedores");

  return { ok: true, message: null };
}

function itemsToJsonb(items: readonly PurchaseOrderItemInput[]): Json {
  return items.map((item) => ({
    skuId: item.skuId,
    skuSnapshot: item.skuSnapshot,
    titleSnapshot: item.titleSnapshot,
    quantityOrdered: item.quantityOrdered,
    unitCost: item.unitCost,
  })) satisfies Json;
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
