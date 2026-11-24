"use client";

import type { Database } from "@sb/db";
import { createBrowserClient } from "@supabase/ssr";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

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

/**
 * Cliente SÓ para pedir o link de "esqueci a senha" (D-863), no fluxo
 * IMPLÍCITO.
 *
 * O cliente de `@supabase/ssr` usa PKCE: o link do e-mail voltaria com
 * `?code=`, e trocar o código exige o verificador guardado NESTE navegador —
 * quem pede no computador e abre o e-mail no celular ficaria sem acesso. No
 * implícito o link volta com a sessão no fragmento e `type=recovery`, o mesmo
 * formato do novo link de acesso de `/usuarios`, que a tela de entrada já lê
 * (`invite-hash.ts`). Ele não guarda sessão: só faz o pedido.
 */
export function createRecoveryClient(): SupabaseClient<Database> {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
    { auth: { flowType: "implicit", persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );
}

/** Cliente do navegador. Usa apenas a chave publicável — nunca a secreta. */
export function createClient(): SupabaseClient<Database> {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  );
}
