import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { canGenerateProductDiagnostics } from "@/features/product-diagnostics/product-diagnostic-permissions";

export async function getProductDiagnosticsAccess() {
  const access = await getCurrentAccess();
  if (!access) return { access: null, status: 401 as const, canGenerate: false };
  return {
    access,
    status: 200 as const,
    canGenerate: canGenerateProductDiagnostics(access.role, access.mustChangePassword),
  };
}
