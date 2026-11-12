import { randomBytes } from "node:crypto";

import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";
import type { MercadoLivreOAuthConfig, RequestTokenOptions } from "@sb/mercado-livre";
import {
  buildAuthorizationUrl,
  createPkcePair,
  decryptToken,
  encryptToken,
  exchangeCodeForToken,
} from "@sb/mercado-livre";

import type { Caller } from "./auth.js";
import type { Enqueuer } from "./enqueue.js";

/**
 * Conexão de conta Mercado Livre: `POST /v1/ml-accounts/connect` +
 * `GET /oauth/mercado-livre/callback` (`docs/API.md` secao 2).
 *
 * A conta em si (`ml_accounts`) é criada pelo `web`, direto sob RLS — só
 * ADMIN escreve (`ml_accounts_admin_writes`). O que exige a `api` é o que
 * precisa de segredo: `client_secret` e a chave de cifra dos tokens nunca
 * podem chegar ao navegador (docs/ARCHITECTURE.md secao 18).
 *
 * Confirmado (`docs/MERCADO_LIVRE.md` secao 2.2, D-041): não existe fluxo
 * multi-conta — é o Authorization Code Grant padrão, repetido uma vez por
 * loja, sempre pelo ADMIN daquela conta ML específica.
 */

const STATE_TTL_MS = 15 * 60 * 1000;

export interface MlAccountsDeps {
  db: AdminClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  logger: Logger;
  enqueuer: Enqueuer;
  now?: () => Date;
  requestOptions?: RequestTokenOptions;
}

export type ConnectOutcome =
  | { status: "redirect"; authorizationUrl: string }
  | { status: "not_found" }
  | { status: "rejected"; reason: string };

/**
 * Inicia a autorização de UMA conta: grava o `state` de CSRF e devolve a URL
 * para onde o navegador do ADMIN deve ir.
 */
export async function startConnect(
  deps: MlAccountsDeps,
  caller: Caller,
  mlAccountId: string,
): Promise<ConnectOutcome> {
  const account = await deps.db
    .from("ml_accounts")
    .select("id, status")
    .eq("id", mlAccountId)
    .eq("organization_id", caller.organizationId)
    .maybeSingle();

  if (account.error !== null || account.data === null) {
    return { status: "not_found" };
  }

  const now = deps.now?.() ?? new Date();

  // REAUTORIZAR conta conectada só quando a credencial dela parou (lote 1 do
  // pente fino, 18/09). /contas avisava "token vencido… até ela ser
  // reautorizada" e não tinha como: esta função recusava toda conta CONNECTED.
  // "Parou" é a mesma regra do cartão da tela (`get_ml_account_cards`:
  // `access_token_expires_at < now()`) — ou nenhuma credencial gravada. Conta
  // saudável continua recusada: reconectar à toa só abre a janela de trocar a
  // loja de lugar (ver a conferência do seller em `completeConnect`).
  if (account.data.status === "CONNECTED") {
    const credential = await deps.db
      .from("ml_credentials")
      .select("access_token_expires_at")
      .eq("ml_account_id", mlAccountId)
      .maybeSingle();

    const parada =
      credential.error === null &&
      (credential.data === null || new Date(credential.data.access_token_expires_at).getTime() < now.getTime());

    if (!parada) {
      return { status: "rejected", reason: "conta já conectada" };
    }

    deps.logger.info("ml_oauth_reconnect_started", { ml_account_id: mlAccountId });
  }
  const expiresAt = new Date(now.getTime() + STATE_TTL_MS);
  // 32 bytes de entropia, sem caracteres que precisem de escape em querystring.
  const state = randomBytes(32).toString("base64url");
  const pkce = createPkcePair();

  const inserted = await deps.db.from("ml_oauth_states").insert({
    state,
    organization_id: caller.organizationId,
    ml_account_id: mlAccountId,
    created_by: caller.userId,
    expires_at: expiresAt.toISOString(),
    // O verifier prova na troca de token que foi esta api quem iniciou o
    // fluxo. Fica cifrado e inacessível pela Data API; só o challenge vai ao
    // navegador/Mercado Livre (D-049).
    code_verifier_ciphertext: encryptToken(pkce.codeVerifier, deps.encryptionKey),
  });

  if (inserted.error !== null) {
    deps.logger.error("ml_oauth_state_not_created", {
      ml_account_id: mlAccountId,
      reason: inserted.error.message,
    });

    return { status: "rejected", reason: "não foi possível iniciar a autorização" };
  }

  deps.logger.info("ml_oauth_connect_started", { ml_account_id: mlAccountId });

  return {
    status: "redirect",
    authorizationUrl: buildAuthorizationUrl(deps.oauth, {
      state,
      codeChallenge: pkce.codeChallenge,
      codeChallengeMethod: pkce.codeChallengeMethod,
    }),
  };
}

export interface CallbackParams {
  state: string;
  code?: string;
  /** Presente quando o ADMIN nega o consentimento no Mercado Livre. */
  error?: string;
}

export type CallbackOutcome =
  | { status: "connected"; mlAccountId: string }
  | { status: "invalid_state" }
  | { status: "rejected"; reason: string };

/**
 * Conclui a autorização: troca o `code`, cifra os tokens e marca a conta
 * `CONNECTED`. Chamada pelo redirecionamento do próprio Mercado Livre — sem
 * JWT, sem OIDC. A única defesa é o `state` (docs/API.md secao 2).
 */
export async function completeConnect(
  deps: MlAccountsDeps,
  params: CallbackParams,
): Promise<CallbackOutcome> {
  const now = deps.now?.() ?? new Date();

  // Consumo ATÔMICO: um único UPDATE com as três condições na cláusula WHERE,
  // não um SELECT seguido de UPDATE. Duas chamadas concorrentes com o mesmo
  // `state` (aba duplicada, retry do navegador) só deixam uma passar — a
  // outra encontra `consumed_at` já preenchido e cai em `invalid_state`.
  const claimed = await deps.db
    .from("ml_oauth_states")
    .update({ consumed_at: now.toISOString() })
    .eq("state", params.state)
    .is("consumed_at", null)
    .gt("expires_at", now.toISOString())
    .select("organization_id, ml_account_id, code_verifier_ciphertext")
    .maybeSingle();

  if (claimed.error !== null || claimed.data === null) {
    return { status: "invalid_state" };
  }

  const {
    organization_id: organizationId,
    ml_account_id: mlAccountId,
    code_verifier_ciphertext: codeVerifierCiphertext,
  } = claimed.data;

  if (params.error !== undefined || params.code === undefined) {
    await markError(deps, mlAccountId, `autorização negada: ${params.error ?? "code ausente"}`);

    return { status: "rejected", reason: "autorização negada no Mercado Livre" };
  }

  if (codeVerifierCiphertext === null) {
    const reason = "state OAuth sem verificador PKCE; reinicie a conexão";
    deps.logger.error("ml_oauth_pkce_verifier_missing", { ml_account_id: mlAccountId });
    await markError(deps, mlAccountId, reason);

    return { status: "rejected", reason: "autorização expirada; inicie a conexão novamente" };
  }

  let codeVerifier: string;

  try {
    codeVerifier = decryptToken(codeVerifierCiphertext, deps.encryptionKey);
  } catch {
    const reason = "verificador PKCE inválido ou ilegível; reinicie a conexão";
    deps.logger.error("ml_oauth_pkce_verifier_invalid", { ml_account_id: mlAccountId });
    await markError(deps, mlAccountId, reason);

    return { status: "rejected", reason: "autorização expirada; inicie a conexão novamente" };
  }

  let token;

  try {
    token = await exchangeCodeForToken(
      deps.oauth,
      params.code,
      deps.requestOptions ?? {},
      codeVerifier,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : "erro desconhecido";

    deps.logger.error("ml_oauth_exchange_failed", { ml_account_id: mlAccountId, reason });
    await markError(deps, mlAccountId, reason);

    return { status: "rejected", reason: "não foi possível concluir a autorização com o Mercado Livre" };
  }

  // A RPC confere o vendedor com a linha travada. Conta e par de tokens
  // ficam na mesma transação, com a trava de renovação anterior invalidada.
  const connected = await deps.db.rpc("ml_connect_account", {
    p_organization_id: organizationId,
    p_ml_account_id: mlAccountId,
    p_seller_id: token.user_id,
    p_connected_at: now.toISOString(),
    p_access_token_ciphertext: encryptToken(token.access_token, deps.encryptionKey),
    p_refresh_token_ciphertext: encryptToken(token.refresh_token, deps.encryptionKey),
    p_access_token_expires_at: new Date(now.getTime() + token.expires_in * 1000).toISOString(),
    p_scopes: token.scope.split(" "),
  });

  if (connected.error?.code === "PT409") {
    deps.logger.warn("ml_oauth_seller_mismatch", { ml_account_id: mlAccountId, received_seller_id: token.user_id });

    return {
      status: "rejected",
      reason: "a conta autorizada no Mercado Livre não é a desta loja — entre com o usuário da própria loja",
    };
  }

  if (connected.error !== null || connected.data === null) {
    deps.logger.error("ml_account_not_connected", { ml_account_id: mlAccountId, code: connected.error?.code });

    return { status: "rejected", reason: "não foi possível gravar a conexão da conta" };
  }

  const slug = connected.data;

  // Dispara o backfill de história (fila `backfill`, prioridade baixa) assim
  // que a conta conecta — sem isso, os pedidos anteriores à conexão nunca
  // apareceriam: a reconciliação por janela só cobre dali para frente
  // (`docs/MERCADO_LIVRE.md` secao 3). Best-effort: falhar em enfileirar não
  // desfaz a conexão, que já está gravada — o próximo `POST .../connect`
  // encontraria a conta CONNECTED e não tentaria de novo; registrado como
  // pendência a resolver manualmente se acontecer (log de erro abaixo).
  const backfillEnqueued = await deps.enqueuer
    .enqueue({
      jobType: "backfill.orders",
      organizationId,
      dedupeKey: `backfill-orders:${slug}:start`,
      queue: "backfill",
      payload: { mlAccountId },
    })
    .catch((error: unknown) => {
      deps.logger.error("backfill_not_triggered", {
        ml_account_id: mlAccountId,
        reason: error instanceof Error ? error.message : "erro desconhecido",
      });

      return null;
    });

  deps.logger.info("ml_account_connected", {
    ml_account_id: mlAccountId,
    seller_id: token.user_id,
    backfill_enqueued: backfillEnqueued !== null,
  });

  return { status: "connected", mlAccountId };
}

async function markError(deps: MlAccountsDeps, mlAccountId: string, reason: string): Promise<void> {
  // Best-effort: se isto falhar, o erro real já foi logado por quem chamou.
  await deps.db
    .from("ml_accounts")
    .update({ status: "ERROR", last_error: reason.slice(0, 2000) })
    .eq("id", mlAccountId);
}
