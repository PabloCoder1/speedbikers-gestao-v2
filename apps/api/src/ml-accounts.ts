import { randomBytes } from "node:crypto";

import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";
import type { MercadoLivreOAuthConfig, RequestTokenOptions } from "@sb/mercado-livre";
import { buildAuthorizationUrl, encryptToken, exchangeCodeForToken } from "@sb/mercado-livre";

import type { Caller } from "./auth.js";

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

  if (account.data.status === "CONNECTED") {
    return { status: "rejected", reason: "conta já conectada" };
  }

  const now = deps.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + STATE_TTL_MS);
  // 32 bytes de entropia, sem caracteres que precisem de escape em querystring.
  const state = randomBytes(32).toString("base64url");

  const inserted = await deps.db.from("ml_oauth_states").insert({
    state,
    organization_id: caller.organizationId,
    ml_account_id: mlAccountId,
    created_by: caller.userId,
    expires_at: expiresAt.toISOString(),
  });

  if (inserted.error !== null) {
    deps.logger.error("ml_oauth_state_not_created", {
      ml_account_id: mlAccountId,
      reason: inserted.error.message,
    });

    return { status: "rejected", reason: "não foi possível iniciar a autorização" };
  }

  deps.logger.info("ml_oauth_connect_started", { ml_account_id: mlAccountId });

  return { status: "redirect", authorizationUrl: buildAuthorizationUrl(deps.oauth, { state }) };
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
    .select("organization_id, ml_account_id")
    .maybeSingle();

  if (claimed.error !== null || claimed.data === null) {
    return { status: "invalid_state" };
  }

  const { ml_account_id: mlAccountId } = claimed.data;

  if (params.error !== undefined || params.code === undefined) {
    await markError(deps, mlAccountId, `autorização negada: ${params.error ?? "code ausente"}`);

    return { status: "rejected", reason: "autorização negada no Mercado Livre" };
  }

  let token;

  try {
    token = await exchangeCodeForToken(deps.oauth, params.code, deps.requestOptions ?? {});
  } catch (error) {
    const reason = error instanceof Error ? error.message : "erro desconhecido";

    deps.logger.error("ml_oauth_exchange_failed", { ml_account_id: mlAccountId, reason });
    await markError(deps, mlAccountId, reason);

    return { status: "rejected", reason: "não foi possível concluir a autorização com o Mercado Livre" };
  }

  const accessTokenExpiresAt = new Date(now.getTime() + token.expires_in * 1000);

  // Constraint completa (não parcial): upsert é seguro aqui, diferente do que
  // vale para `sku_listing_links` (docs/DATABASE.md secao 4).
  const credentials = await deps.db.from("ml_credentials").upsert(
    {
      ml_account_id: mlAccountId,
      access_token_ciphertext: encryptToken(token.access_token, deps.encryptionKey),
      refresh_token_ciphertext: encryptToken(token.refresh_token, deps.encryptionKey),
      access_token_expires_at: accessTokenExpiresAt.toISOString(),
      scopes: token.scope.split(" "),
    },
    { onConflict: "ml_account_id" },
  );

  if (credentials.error !== null) {
    deps.logger.error("ml_credentials_not_stored", {
      ml_account_id: mlAccountId,
      reason: credentials.error.message,
    });

    return { status: "rejected", reason: "não foi possível gravar as credenciais" };
  }

  const accountUpdate = await deps.db
    .from("ml_accounts")
    .update({
      seller_id: token.user_id,
      status: "CONNECTED",
      connected_at: now.toISOString(),
      last_error: null,
    })
    .eq("id", mlAccountId);

  if (accountUpdate.error !== null) {
    deps.logger.error("ml_account_not_connected", {
      ml_account_id: mlAccountId,
      reason: accountUpdate.error.message,
    });

    return { status: "rejected", reason: "credenciais gravadas, mas a conta não pôde ser marcada como conectada" };
  }

  deps.logger.info("ml_account_connected", { ml_account_id: mlAccountId, seller_id: token.user_id });

  return { status: "connected", mlAccountId };
}

async function markError(deps: MlAccountsDeps, mlAccountId: string, reason: string): Promise<void> {
  // Best-effort: se isto falhar, o erro real já foi logado por quem chamou.
  await deps.db
    .from("ml_accounts")
    .update({ status: "ERROR", last_error: reason.slice(0, 2000) })
    .eq("id", mlAccountId);
}
