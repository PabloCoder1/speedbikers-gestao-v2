import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";

const DRAFT_MUTATION_ROLES = new Set(["admin", "gestor", "operador"]);
const APPROVAL_MUTATION_ROLES = new Set(["admin", "gestor"]);

export type PurchaseOrderPermissions = {
  canCreateDraft: boolean;
  canEditDraft: boolean;
  canApprove: boolean;
  canReopen: boolean;
  canMarkOrdered: boolean;
  canCancel: boolean;
  canChangeTransitAccounting: boolean;
  canCancelRemaining: boolean;
  canReceiveNfe: boolean;
};

function derivePermissions(role: string): PurchaseOrderPermissions {
  const isDraftRole = DRAFT_MUTATION_ROLES.has(role);
  const isApprovalRole = APPROVAL_MUTATION_ROLES.has(role);
  return {
    canCreateDraft: isDraftRole,
    canEditDraft: isDraftRole,
    canApprove: isApprovalRole,
    canReopen: isApprovalRole,
    canMarkOrdered: isApprovalRole,
    canCancel: isApprovalRole,
    canChangeTransitAccounting: isApprovalRole,
    canCancelRemaining: isApprovalRole,
    canReceiveNfe: isDraftRole,
  };
}

export async function getPurchaseOrderMutationAccess() {
  const access = await getCurrentAccess();
  if (!access) return { access: null, status: 401 as const, permissions: null };
  if (access.mustChangePassword || !DRAFT_MUTATION_ROLES.has(access.role)) {
    return { access: null, status: 403 as const, permissions: null };
  }
  return { access, status: 200 as const, permissions: derivePermissions(access.role) };
}
