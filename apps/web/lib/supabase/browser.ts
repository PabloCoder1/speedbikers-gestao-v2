"use client";

import type { Database } from "@sb/db";
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Variáveis de ambiente que faltam para o navegador falar com o Supabase.
 *
 * Sem esta checagem, `createBrowserClient("", "")` falha com uma mensagem da
 * biblioteca que não diz o que fazer. Quem está subindo o ambiente pela
 * primeira vez merece o nome da variável.
 */
export function missingBrowserEnv(): string[] {
  const missing: string[] = [];

  if ((process.env.NEXT_PUBLIC_SUPABASE_URL ?? "") === "") {
    missing.push("NEXT_PUBLIC_SUPABASE_URL");
  }

  if ((process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "") === "") {
    missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  }

  return missing;
}

/** Cliente do navegador. Usa apenas a chave publicável — nunca a secreta. */
export function createClient(): SupabaseClient<Database> {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  );
}
