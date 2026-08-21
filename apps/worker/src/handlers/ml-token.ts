import type { AdminClient } from "@sb/db";
import type { MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import { decryptToken, encryptToken, refreshAccessToken } from "@sb/mercado-livre";

/**
 * Obtenção de `access_token` válido, compartilhada por todo handler que
 * chama o Mercado Livre (`sync.orders.window`, `backfill.orders`, e o que
 * vier depois).
 */

export interface TokenDeps {
  db: AdminClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
}

/** Buffer antes de expirar em que já vale renovar, em vez de arriscar 401 no meio da varredura. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const REFRESH_LOCK_MS = 60 * 1000;

export type AccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; retryable: boolean; reason: string };

/**
 * Garante um `access_token` válido, renovando quando perto de expirar.
 *
 * A trava (`refresh_locked_until`) existe porque o `refresh_token` é de uso
 * único (`docs/MERCADO_LIVRE.md` secao 6): um refresh concorrente sem trava
 * invalida o token que a outra execução ainda ia usar. Reivindicação
 * ATÔMICA — um único `UPDATE ... WHERE refresh_locked_until IS NULL OR
 * refresh_locked_until < now()` — mesmo padrão do consumo de `state` em
 * `apps/api/src/ml-accounts.ts`.
 */
export async function ensureAccessToken(
  deps: TokenDeps,
  mlAccountId: string,
  now: Date,
): Promise<AccessTokenResult> {
  const credentials = await deps.db
    .from("ml_credentials")
    .select("access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at")
    .eq("ml_account_id", mlAccountId)
    .maybeSingle();

  if (credentials.error !== null || credentials.data === null) {
    return { ok: false, retryable: false, reason: "conta CONNECTED sem credenciais gravadas" };
  }

  const expiresAt = new Date(credentials.data.access_token_expires_at);

  if (expiresAt.getTime() - now.getTime() > REFRESH_BUFFER_MS) {
    return { ok: true, accessToken: decryptToken(credentials.data.access_token_ciphertext, deps.encryptionKey) };
  }

  const claimed = await deps.db
    .from("ml_credentials")
    .update({ refresh_locked_until: new Date(now.getTime() + REFRESH_LOCK_MS).toISOString() })
    .eq("ml_account_id", mlAccountId)
    .or(`refresh_locked_until.is.null,refresh_locked_until.lt.${now.toISOString()}`)
    .select("ml_account_id")
    .maybeSingle();

  if (claimed.error !== null || claimed.data === null) {
    return { ok: false, retryable: true, reason: "refresh do token em andamento por outra execução" };
  }

  let token;

  try {
    token = await refreshAccessToken(
      deps.oauth,
      decryptToken(credentials.data.refresh_token_ciphertext, deps.encryptionKey),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : "falha ao renovar o token";

    await deps.db
      .from("ml_credentials")
      .update({ refresh_locked_until: null })
      .eq("ml_account_id", mlAccountId);
    await deps.db
      .from("ml_accounts")
      .update({ status: "ERROR", last_error: reason.slice(0, 2000) })
      .eq("id", mlAccountId);

    return { ok: false, retryable: false, reason };
  }

  const newExpiresAt = new Date(now.getTime() + token.expires_in * 1000);

  await deps.db
    .from("ml_credentials")
    .update({
      access_token_ciphertext: encryptToken(token.access_token, deps.encryptionKey),
      refresh_token_ciphertext: encryptToken(token.refresh_token, deps.encryptionKey),
      access_token_expires_at: newExpiresAt.toISOString(),
      refresh_locked_until: null,
    })
    .eq("ml_account_id", mlAccountId);

  return { ok: true, accessToken: token.access_token };
}
