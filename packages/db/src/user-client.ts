import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "./types.js";

/**
 * Cliente Supabase "como o usuário" — mesmo modelo A de `apps/web`
 * (`lib/supabase/server.ts`, D-012): lê o banco DIRETO, sob RLS, com a
 * identidade de quem está logado. Diferente de `createAdminClient`
 * (`service_role`, ignora RLS por completo).
 *
 * Sem cookie aqui: a `api` recebe o JWT pronto no header `Authorization` do
 * próprio request, então só precisa repassá-lo — não há sessão para
 * persistir nem renovar (`persistSession`/`autoRefreshToken` desligados,
 * mesmo padrão de `createAdminClient`).
 *
 * **Por que isto existe:** ferramentas do Copiloto (`docs/COPILOT.md`
 * secao 3, "permissão é aplicada na camada de ferramenta, não no prompt")
 * chamam RPCs `security invoker` como `get_sales_summary` — rodar essas
 * RPCs com `service_role` devolveria dado de TODAS as organizações (RLS
 * bypassada), e reimplementar `has_account_access` em TypeScript seria a
 * mesma categoria de duplicação que `docs/ARCHITECTURE.md` secao 7 já
 * proíbe para fórmulas de métrica. A RLS de sempre — a mesma que o `web`
 * usa — é a autorização real; este cliente só a alcança de dentro da `api`.
 */

export interface UserClientConfig {
  supabaseUrl: string;
  publishableKey: string;
}

export type UserClient = SupabaseClient<Database>;

/** Erro lançado quando a configuração do cliente "como o usuário" é inválida. */
export class UserClientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserClientConfigError";
  }
}

const PUBLISHABLE_KEY_MIN_LENGTH = 20;

export function createUserClient(config: UserClientConfig, accessToken: string): UserClient {
  if (config.supabaseUrl.length === 0) {
    throw new UserClientConfigError("supabaseUrl vazio.");
  }

  if (!config.supabaseUrl.startsWith("http")) {
    throw new UserClientConfigError("supabaseUrl deve ser uma URL http(s).");
  }

  if (config.publishableKey.length < PUBLISHABLE_KEY_MIN_LENGTH) {
    throw new UserClientConfigError("publishableKey ausente ou curta demais.");
  }

  if (accessToken.length === 0) {
    throw new UserClientConfigError("accessToken vazio.");
  }

  return createClient<Database>(config.supabaseUrl, config.publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}
