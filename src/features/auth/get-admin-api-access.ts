import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";

export async function getAdminApiAccess() {
  const access = await getCurrentAccess();
  if (!access) return { access: null, status: 401 as const };
  if (access.mustChangePassword || access.role !== "admin") {
    return { access: null, status: 403 as const };
  }
  return { access, status: 200 as const };
}
