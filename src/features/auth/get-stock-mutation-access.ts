import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";

const STOCK_MUTATION_ROLES = new Set(["admin", "gestor", "operador"]);

export async function getStockMutationAccess() {
  const access = await getCurrentAccess();
  if (!access) return { access: null, status: 401 as const };
  if (access.mustChangePassword || !STOCK_MUTATION_ROLES.has(access.role)) {
    return { access: null, status: 403 as const };
  }
  return { access, status: 200 as const };
}
