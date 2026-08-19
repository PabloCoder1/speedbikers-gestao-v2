import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { createClient } from "@/lib/supabase/server";

export type SupplierOption = {
  id: string;
  name: string;
  document: string | null;
};

export async function getActiveSuppliers(): Promise<SupplierOption[]> {
  const access = await getCurrentAccess();
  if (!access) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("suppliers")
    .select("id, name, document")
    .eq("organization_id", access.organizationId)
    .eq("is_active", true)
    .order("name");

  if (error) throw new Error(`SUPPLIERS_LOOKUP_FAILED:${error.message}`);
  return data ?? [];
}
