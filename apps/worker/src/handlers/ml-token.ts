import type { AdminClient } from "@sb/db";
import type { MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import {
  MercadoLivreApiError,
  decryptToken,
  encryptToken,
  refreshAccessToken,
  tokenErrorBodySchema,
} from "@sb/mercado-livre";

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
 * A troca de token foi RECUSADA de vez: o Mercado Livre respondeu 400/401 com
 * o erro OAuth no corpo (`invalid_grant`, `invalid_client`...). Só isso pede
 * reconectar a conta.
 *
 * Todo o resto é passageiro e NÃO derruba a conta -- 403 sem esse corpo, 429
 * e 5xx depois das novas tentativas, falha de rede, resposta fora da forma.
 * Em 27/09/2026 um 403 de bloqueio na saída de UMA instância do worker
 * marcou as quatro contas como ERROR, e a sincronização ficou 32 horas parada
 * até alguém recolocá-las em CONNECTED; os refresh tokens estavam intactos.
 */
function recusaDefinitiva(error: unknown): boolean {
  return (
    error instanceof MercadoLivreApiError &&
    (error.status === 400 || error.status === 401) &&
    tokenErrorBodySchema.safeParse(error.body).success
  );
}

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

  // A credencial usada daqui em diante é a que a TRAVA devolve, não a lida
  // acima. Entre as duas leituras outra execução pode ter renovado e soltado a
  // trava: o `refresh_token` lido antes já foi consumido, e usá-lo daria
  // `invalid_grant` -- a recusa definitiva que derruba a conta para ERROR
  // (auditoria de 2026-09-28).
  const claimed = await deps.db
    .from("ml_credentials")
    .update({ refresh_locked_until: new Date(now.getTime() + REFRESH_LOCK_MS).toISOString() })
    .eq("ml_account_id", mlAccountId)
    .or(`refresh_locked_until.is.null,refresh_locked_until.lt.${now.toISOString()}`)
    .select("access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at")
    .maybeSingle();

  if (claimed.error !== null || claimed.data === null) {
    return { ok: false, retryable: true, reason: "refresh do token em andamento por outra execução" };
  }

  if (new Date(claimed.data.access_token_expires_at).getTime() - now.getTime() > REFRESH_BUFFER_MS) {
    await deps.db
      .from("ml_credentials")
      .update({ refresh_locked_until: null })
      .eq("ml_account_id", mlAccountId);

    return { ok: true, accessToken: decryptToken(claimed.data.access_token_ciphertext, deps.encryptionKey) };
  }

  let token;

  try {
    token = await refreshAccessToken(
      deps.oauth,
      decryptToken(claimed.data.refresh_token_ciphertext, deps.encryptionKey),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : "falha ao renovar o token";

    await deps.db
      .from("ml_credentials")
      .update({ refresh_locked_until: null })
      .eq("ml_account_id", mlAccountId);

    if (!recusaDefinitiva(error)) {
      // A conta continua CONNECTED: o job falha com nova tentativa, a próxima
      // execução tenta renovar de novo, e a tela já avisa "token vencido numa
      // conta conectada" enquanto isso durar.
      return { ok: false, retryable: true, reason };
    }

    await deps.db
      .from("ml_accounts")
      .update({ status: "ERROR", last_error: reason.slice(0, 2000) })
      .eq("id", mlAccountId);

    return { ok: false, retryable: false, reason };
  }

  const newExpiresAt = new Date(now.getTime() + token.expires_in * 1000);

  const saved = await deps.db
    .from("ml_credentials")
    .update({
      access_token_ciphertext: encryptToken(token.access_token, deps.encryptionKey),
      refresh_token_ciphertext: encryptToken(token.refresh_token, deps.encryptionKey),
      access_token_expires_at: newExpiresAt.toISOString(),
      refresh_locked_until: null,
    })
    .eq("ml_account_id", mlAccountId);

  if (saved.error !== null) {
    // O `refresh_token` antigo já foi consumido e o novo não ficou gravado: a
    // próxima renovação vai dar `invalid_grant`. Sem nova tentativa (ela só
    // anteciparia essa recusa), e com o motivo explícito em `job_runs` em vez
    // de um sucesso que esconde a conta prestes a cair.
    return {
      ok: false,
      retryable: false,
      reason: `token renovado, mas a gravação falhou: ${saved.error.message}`.slice(0, 2000),
    };
  }

  return { ok: true, accessToken: token.access_token };
}
