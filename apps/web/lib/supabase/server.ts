import type { Database } from "@sb/db";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

/**
 * Cliente Supabase do servidor, com a sessão do usuário.
 *
 * Modelo A (D-012): o `web` lê o banco DIRETO, sob RLS, com a identidade de
 * quem está logado. Ele nunca usa `service_role` — essa chave existe só na
 * `api` e no `worker`.
 *
 * Consequência prática: se uma policy estiver errada, o dado vaza aqui. É por
 * isso que todo policy tem teste negativo (docs/TESTING.md).
 */
export async function createClient(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          try {
            for (const { name, value, options } of toSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Component não pode escrever cookie. Ignorar é correto:
            // o `proxy` já renovou a sessão antes da renderização.
          }
        },
      },
    },
  );
}
