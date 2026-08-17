import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

export function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL não está configurada.",
    );
  }

  if (!supabaseSecretKey) {
    throw new Error(
      "SUPABASE_SECRET_KEY não está configurada.",
    );
  }

  return createSupabaseClient(
    supabaseUrl,
    supabaseSecretKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  );
}