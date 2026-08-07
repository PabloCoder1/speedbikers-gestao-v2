import { redirect } from "next/navigation";

import { getCurrentAccess } from "@/features/auth/get-current-access";

export async function requireAdminAccess() {
  const access =
    await getCurrentAccess();

  if (!access) {
    redirect("/login");
  }

  if (access.mustChangePassword) {
    redirect("/trocar-senha");
  }

  if (access.role !== "admin") {
    redirect("/");
  }

  return access;
}