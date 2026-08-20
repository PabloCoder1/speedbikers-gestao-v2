import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "./types.js";

/**
 * Cliente privilegiado, que ignora RLS.
 *
 * USO EXCLUSIVO de `apps/api` e `apps/worker`, com a chave vinda do Secret
 * Manager. Nunca na Vercel, nunca em bundle de navegador, nunca em log
 * (D-012, docs/DEPLOYMENT.md secao 5).
 *
 * O `web` lê o banco com a sessão do usuário e sob RLS — é isso que torna a
 * RLS a rede de segurança real do sistema, e não decoração.
 */

export interface AdminClientConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
}

export type AdminClient = SupabaseClient<Database>;

/** Erro lançado quando a configuração do cliente privilegiado é inválida. */
export class AdminClientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminClientConfigError";
  }
}

const SERVICE_ROLE_MIN_LENGTH = 20;

export function createAdminClient(config: AdminClientConfig): AdminClient {
  if (config.supabaseUrl.length === 0) {
    throw new AdminClientConfigError("supabaseUrl vazio.");
  }

  if (!config.supabaseUrl.startsWith("http")) {
    throw new AdminClientConfigError("supabaseUrl deve ser uma URL http(s).");
  }

  // Checagem de forma, não de valor: a mensagem nunca pode conter a chave.
  if (config.serviceRoleKey.length < SERVICE_ROLE_MIN_LENGTH) {
    throw new AdminClientConfigError("serviceRoleKey ausente ou curta demais.");
  }

  return createClient<Database>(config.supabaseUrl, config.serviceRoleKey, {
    auth: {
      // Processo de servidor: não existe sessão a persistir nem a renovar.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
