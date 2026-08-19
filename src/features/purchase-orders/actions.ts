"use server";

import { revalidatePath } from "next/cache";

import { getPurchaseOrderMutationAccess } from "@/features/auth/get-purchase-order-mutation-access";
import { createAdminClient } from "@/lib/supabase/admin";

const ERROR_MESSAGES: Record<string, string> = {
  purchase_order_not_authorized: "Você não tem permissão para esta ação.",
  purchase_order_not_found: "Pedido de compra não encontrado.",
  stale_purchase_order: "Este pedido foi alterado por outro usuário. Recarregue a página e tente novamente.",
  purchase_order_not_draft: "Este pedido não está mais em rascunho e não pode ser editado.",
  purchase_order_not_approved: "Esta ação exige que o pedido esteja aprovado.",
  purchase_order_not_in_transit: "Esta ação exige que o pedido esteja em trânsito.",
  purchase_order_not_cancellable: "Este pedido não pode mais ser cancelado.",
  purchase_order_supplier_required: "Selecione um fornecedor antes de continuar.",
  purchase_order_destination_required: "Informe o depósito de destino antes de continuar.",
  purchase_order_requires_items: "Adicione ao menos um item ao pedido.",
  purchase_order_has_receipts: "Não é possível remover: este item já tem NF-e vinculada.",
  purchase_order_has_outstanding_receipts: "Não é possível cancelar: já há unidades recebidas neste pedido.",
  purchase_order_item_not_found: "Item do pedido não encontrado.",
  invalid_purchase_order_quantity: "Informe uma quantidade válida.",
  invalid_purchase_order_items: "Nenhum SKU elegível foi encontrado para criar o pedido.",
  invalid_transit_accounting_source: "Opção de trânsito inválida.",
  cannot_add_kit_sku: "Kits não podem ser comprados diretamente — adicione os componentes.",
  supplier_not_found: "Fornecedor não encontrado.",
  invalid_supplier_name: "Informe o nome do fornecedor.",
};

function purchaseOrderErrorMessage(error: { message: string }) {
  const code = Object.keys(ERROR_MESSAGES).find((key) => error.message.includes(key));
  return code ? ERROR_MESSAGES[code] : "Não foi possível completar a ação. Tente novamente.";
}

function revalidatePurchaseOrder(purchaseOrderId?: string | null) {
  revalidatePath("/pedidos-compra");
  revalidatePath("/compras");
  if (purchaseOrderId) revalidatePath(`/pedidos-compra/${purchaseOrderId}`);
}

export async function createPurchaseOrderFromPlanningAction(sourceSkuKeys: string[]): Promise<{
  error: string | null;
  created: boolean;
  purchaseOrderId: string | null;
  orderNumber: string | null;
  existingOpenOrders: { sourceSkuKey: string; purchaseOrderId: string; orderNumber: number; status: string }[];
}> {
  const authorization = await getPurchaseOrderMutationAccess();
  if (!authorization.access) {
    return { error: "Você não tem permissão para esta ação.", created: false, purchaseOrderId: null, orderNumber: null, existingOpenOrders: [] };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("create_purchase_order_from_planning", {
    target_organization_id: authorization.access.organizationId,
    actor_user_id: authorization.access.userId,
    source_sku_keys: sourceSkuKeys,
  });

  if (error) {
    return { error: purchaseOrderErrorMessage(error), created: false, purchaseOrderId: null, orderNumber: null, existingOpenOrders: [] };
  }

  const result = data as {
    created: boolean;
    purchaseOrderId?: string;
    orderNumber?: number;
    existingOpenOrders?: { sourceSkuKey: string; purchaseOrderId: string; orderNumber: number; status: string }[];
  };

  if (result.created) revalidatePurchaseOrder(result.purchaseOrderId);

  return {
    error: null,
    created: result.created,
    purchaseOrderId: result.purchaseOrderId ?? null,
    orderNumber: result.orderNumber ? `PC-${String(result.orderNumber).padStart(6, "0")}` : null,
    existingOpenOrders: result.existingOpenOrders ?? [],
  };
}

export async function createBlankPurchaseOrderAction(): Promise<{
  error: string | null;
  purchaseOrderId: string | null;
}> {
  const authorization = await getPurchaseOrderMutationAccess();
  if (!authorization.access) return { error: "Você não tem permissão para esta ação.", purchaseOrderId: null };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("create_blank_purchase_order", {
    target_organization_id: authorization.access.organizationId,
    actor_user_id: authorization.access.userId,
  });

  if (error) return { error: purchaseOrderErrorMessage(error), purchaseOrderId: null };

  const result = data as { purchaseOrderId: string; orderNumber: number };
  revalidatePurchaseOrder(result.purchaseOrderId);
  return { error: null, purchaseOrderId: result.purchaseOrderId };
}

type VersionResult = { error: string | null; version: number | null };

export async function updatePurchaseOrderDraftAction(input: {
  purchaseOrderId: string;
  expectedVersion: number;
  supplierId?: string | null;
  destinationWarehouseKey?: string | null;
  destinationWarehouseName?: string | null;
  notes?: string | null;
  clearNotes?: boolean;
  expectedAt?: string | null;
  clearExpectedAt?: boolean;
}): Promise<VersionResult> {
  const authorization = await getPurchaseOrderMutationAccess();
  if (!authorization.access) return { error: "Você não tem permissão para esta ação.", version: null };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("update_purchase_order_draft", {
    target_organization_id: authorization.access.organizationId,
    actor_user_id: authorization.access.userId,
    target_purchase_order_id: input.purchaseOrderId,
    expected_version: input.expectedVersion,
    supplier_id: input.supplierId ?? null,
    destination_warehouse_key: input.destinationWarehouseKey ?? null,
    destination_warehouse_name: input.destinationWarehouseName ?? null,
    notes: input.notes ?? null,
    expected_at: input.expectedAt ?? null,
    clear_notes: input.clearNotes ?? false,
    clear_expected_at: input.clearExpectedAt ?? false,
  });

  if (error) return { error: purchaseOrderErrorMessage(error), version: null };

  revalidatePurchaseOrder(input.purchaseOrderId);
  return { error: null, version: data as number };
}

export async function upsertPurchaseOrderItemAction(input: {
  purchaseOrderId: string;
  expectedVersion: number;
  sourceSkuKey: string;
  quantityOrdered: number;
  unitCost?: number | null;
  isManualAdd?: boolean;
}): Promise<{ error: string | null; purchaseOrderItemId: string | null; version: number | null }> {
  const authorization = await getPurchaseOrderMutationAccess();
  if (!authorization.access) return { error: "Você não tem permissão para esta ação.", purchaseOrderItemId: null, version: null };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("upsert_purchase_order_item", {
    target_organization_id: authorization.access.organizationId,
    actor_user_id: authorization.access.userId,
    target_purchase_order_id: input.purchaseOrderId,
    expected_version: input.expectedVersion,
    source_sku_key: input.sourceSkuKey,
    quantity_ordered: input.quantityOrdered,
    unit_cost: input.unitCost ?? null,
    is_manual_add: input.isManualAdd ?? false,
  });

  if (error) return { error: purchaseOrderErrorMessage(error), purchaseOrderItemId: null, version: null };

  const result = data as { purchaseOrderItemId: string; version: number };
  revalidatePurchaseOrder(input.purchaseOrderId);
  return { error: null, ...result };
}

export async function removePurchaseOrderItemAction(input: {
  purchaseOrderId: string;
  expectedVersion: number;
  purchaseOrderItemId: string;
}): Promise<VersionResult> {
  const authorization = await getPurchaseOrderMutationAccess();
  if (!authorization.access) return { error: "Você não tem permissão para esta ação.", version: null };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("remove_purchase_order_item", {
    target_organization_id: authorization.access.organizationId,
    actor_user_id: authorization.access.userId,
    target_purchase_order_id: input.purchaseOrderId,
    expected_version: input.expectedVersion,
    target_purchase_order_item_id: input.purchaseOrderItemId,
  });

  if (error) return { error: purchaseOrderErrorMessage(error), version: null };

  revalidatePurchaseOrder(input.purchaseOrderId);
  return { error: null, version: data as number };
}

export async function upsertSupplierProductLinkAction(input: {
  supplierId: string;
  sourceSkuKey: string;
  sourceSku?: string | null;
  supplierSku?: string | null;
  isPreferred?: boolean;
  lastOrderedUnitCost?: number | null;
  confirmReplace?: boolean;
}): Promise<{ error: string | null; replaced: boolean; currentPreferredSupplierId: string | null }> {
  const authorization = await getPurchaseOrderMutationAccess();
  if (!authorization.access) return { error: "Você não tem permissão para esta ação.", replaced: false, currentPreferredSupplierId: null };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("upsert_supplier_product_link", {
    target_organization_id: authorization.access.organizationId,
    actor_user_id: authorization.access.userId,
    supplier_id: input.supplierId,
    source_sku_key: input.sourceSkuKey,
    source_sku: input.sourceSku ?? null,
    supplier_sku: input.supplierSku ?? null,
    is_preferred: input.isPreferred ?? false,
    last_ordered_unit_cost: input.lastOrderedUnitCost ?? null,
    confirm_replace: input.confirmReplace ?? false,
  });

  if (error) return { error: purchaseOrderErrorMessage(error), replaced: false, currentPreferredSupplierId: null };

  const result = data as { replaced: boolean; currentPreferredSupplierId?: string };
  return { error: null, replaced: result.replaced, currentPreferredSupplierId: result.currentPreferredSupplierId ?? null };
}

export async function approvePurchaseOrderAction(input: {
  purchaseOrderId: string;
  expectedVersion: number;
}): Promise<VersionResult> {
  const authorization = await getPurchaseOrderMutationAccess();
  if (!authorization.access || !authorization.permissions?.canApprove) {
    return { error: "Você não tem permissão para esta ação.", version: null };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("approve_purchase_order", {
    target_organization_id: authorization.access.organizationId,
    actor_user_id: authorization.access.userId,
    target_purchase_order_id: input.purchaseOrderId,
    expected_version: input.expectedVersion,
  });

  if (error) return { error: purchaseOrderErrorMessage(error), version: null };

  revalidatePurchaseOrder(input.purchaseOrderId);
  return { error: null, version: data as number };
}

export async function reopenPurchaseOrderAction(input: {
  purchaseOrderId: string;
  expectedVersion: number;
}): Promise<VersionResult> {
  const authorization = await getPurchaseOrderMutationAccess();
  if (!authorization.access || !authorization.permissions?.canReopen) {
    return { error: "Você não tem permissão para esta ação.", version: null };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("reopen_purchase_order", {
    target_organization_id: authorization.access.organizationId,
    actor_user_id: authorization.access.userId,
    target_purchase_order_id: input.purchaseOrderId,
    expected_version: input.expectedVersion,
  });

  if (error) return { error: purchaseOrderErrorMessage(error), version: null };

  revalidatePurchaseOrder(input.purchaseOrderId);
  return { error: null, version: data as number };
}

export async function markPurchaseOrderOrderedAction(input: {
  purchaseOrderId: string;
  expectedVersion: number;
  destinationWarehouseKey: string;
  destinationWarehouseName: string;
  transitAccountingSource: "internal" | "upseller_confirmed";
  expectedAt?: string | null;
}): Promise<VersionResult & { expectedAt?: string }> {
  const authorization = await getPurchaseOrderMutationAccess();
  if (!authorization.access || !authorization.permissions?.canMarkOrdered) {
    return { error: "Você não tem permissão para esta ação.", version: null };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("mark_purchase_order_ordered", {
    target_organization_id: authorization.access.organizationId,
    actor_user_id: authorization.access.userId,
    target_purchase_order_id: input.purchaseOrderId,
    expected_version: input.expectedVersion,
    destination_warehouse_key: input.destinationWarehouseKey,
    destination_warehouse_name: input.destinationWarehouseName,
    transit_accounting_source: input.transitAccountingSource,
    expected_at: input.expectedAt ?? null,
  });

  if (error) return { error: purchaseOrderErrorMessage(error), version: null };

  const result = data as { version: number; expectedAt: string };
  revalidatePurchaseOrder(input.purchaseOrderId);
  return { error: null, ...result };
}

export async function changePurchaseOrderTransitAccountingAction(input: {
  purchaseOrderId: string;
  expectedVersion: number;
  transitAccountingSource: "internal" | "upseller_confirmed";
}): Promise<VersionResult> {
  const authorization = await getPurchaseOrderMutationAccess();
  if (!authorization.access || !authorization.permissions?.canChangeTransitAccounting) {
    return { error: "Você não tem permissão para esta ação.", version: null };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("change_purchase_order_transit_accounting", {
    target_organization_id: authorization.access.organizationId,
    actor_user_id: authorization.access.userId,
    target_purchase_order_id: input.purchaseOrderId,
    expected_version: input.expectedVersion,
    transit_accounting_source: input.transitAccountingSource,
  });

  if (error) return { error: purchaseOrderErrorMessage(error), version: null };

  revalidatePurchaseOrder(input.purchaseOrderId);
  return { error: null, version: data as number };
}

export async function cancelPurchaseOrderAction(input: {
  purchaseOrderId: string;
  expectedVersion: number;
}): Promise<VersionResult> {
  const authorization = await getPurchaseOrderMutationAccess();
  if (!authorization.access || !authorization.permissions?.canCancel) {
    return { error: "Você não tem permissão para esta ação.", version: null };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("cancel_purchase_order", {
    target_organization_id: authorization.access.organizationId,
    actor_user_id: authorization.access.userId,
    target_purchase_order_id: input.purchaseOrderId,
    expected_version: input.expectedVersion,
  });

  if (error) return { error: purchaseOrderErrorMessage(error), version: null };

  revalidatePurchaseOrder(input.purchaseOrderId);
  return { error: null, version: data as number };
}

export async function cancelPurchaseOrderItemRemainingAction(input: {
  purchaseOrderId: string;
  expectedVersion: number;
  purchaseOrderItemId: string;
}): Promise<VersionResult & { status?: string }> {
  const authorization = await getPurchaseOrderMutationAccess();
  if (!authorization.access || !authorization.permissions?.canCancelRemaining) {
    return { error: "Você não tem permissão para esta ação.", version: null };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("cancel_purchase_order_item_remaining", {
    target_organization_id: authorization.access.organizationId,
    actor_user_id: authorization.access.userId,
    target_purchase_order_id: input.purchaseOrderId,
    expected_version: input.expectedVersion,
    target_purchase_order_item_id: input.purchaseOrderItemId,
  });

  if (error) return { error: purchaseOrderErrorMessage(error), version: null };

  const result = data as { version: number; status: string };
  revalidatePurchaseOrder(input.purchaseOrderId);
  return { error: null, ...result };
}

export async function createSupplierAction(input: {
  name: string;
  legalName?: string;
  document?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  website?: string;
  notes?: string;
}): Promise<{ error: string | null; supplierId: string | null }> {
  const authorization = await getPurchaseOrderMutationAccess();
  if (!authorization.access) return { error: "Você não tem permissão para esta ação.", supplierId: null };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("create_supplier", {
    target_organization_id: authorization.access.organizationId,
    actor_user_id: authorization.access.userId,
    name: input.name,
    legal_name: input.legalName ?? null,
    document: input.document ?? null,
    contact_name: input.contactName ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    whatsapp: input.whatsapp ?? null,
    website: input.website ?? null,
    notes: input.notes ?? null,
  });

  if (error) return { error: purchaseOrderErrorMessage(error), supplierId: null };

  revalidatePurchaseOrder(null);
  return { error: null, supplierId: data as string };
}
