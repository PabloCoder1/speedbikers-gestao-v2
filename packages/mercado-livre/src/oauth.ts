import { z } from "zod";

import { MercadoLivreApiError } from "./errors.js";
import { classifyStatus, computeBackoffDelayMs, parseRetryAfterMs } from "./retry.js";

/**
 * Domínio de autorização é por país (`.com.br`, `.com.ar`, `.com.uy`, ...).
 * A Speed Bikers opera só contas MLB — fixo aqui em vez de parametrizado
 * (`docs/MERCADO_LIVRE.md` secao 2.2). Revisar se a operação expandir de país.
 */
const AUTHORIZATION_BASE_URL = "https://auth.mercadolivre.com.br/authorization";

/** O endpoint de token é único e global, independente do país da conta. */
const TOKEN_URL = "https://api.mercadolibre.com/oauth/token";

export interface MercadoLivreOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface BuildAuthorizationUrlOptions {
  /** Protege contra CSRF — grava-se em `ml_oauth_states.state` antes de redirecionar. */
  state: string;
  /** PKCE: obrigatório enviar os dois campos juntos, ou nenhum. */
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
}

/**
 * Monta a URL para onde o ADMIN é redirecionado para autorizar UMA conta.
 *
 * Confirmado (`docs/MERCADO_LIVRE.md` secao 2.2): quem loga aqui precisa ser
 * administrador daquela conta ML específica — colaborador recebe
 * `invalid_operator_user_id` e o grant fica inválido.
 */
export function buildAuthorizationUrl(
  config: MercadoLivreOAuthConfig,
  options: BuildAuthorizationUrlOptions,
): string {
  const url = new URL(AUTHORIZATION_BASE_URL);

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", options.state);

  if (options.codeChallenge !== undefined) {
    url.searchParams.set("code_challenge", options.codeChallenge);
    url.searchParams.set("code_challenge_method", options.codeChallengeMethod ?? "S256");
  }

  return url.toString();
}

/**
 * Corpo de resposta de `POST /oauth/token`, confirmado por leitura direta de
 * `developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao` em
 * 2026-08-21 — mesmo formato para `authorization_code` e `refresh_token`.
 */
export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  /** Segundos até expirar. Confirmado: sempre 21600 (6h) hoje. */
  expires_in: z.number().int().min(1),
  scope: z.string().min(1),
  user_id: z.number().int(),
  /**
   * Uso único: cada refresh devolve um novo e invalida o anterior. Expira
   * sozinho em 6 meses se não for usado (secao 2.2).
   */
  refresh_token: z.string().min(1),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/** Corpo de erro do endpoint de token, confirmado (exemplo real de `invalid_grant`). */
export const tokenErrorBodySchema = z.object({
  error: z.string().min(1),
  error_description: z.string().optional(),
  status: z.number().int().optional(),
  cause: z.array(z.unknown()).optional(),
});

export interface RequestTokenOptions {
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_MAX_ATTEMPTS = 4;

/**
 * POST em `/oauth/token`, sempre `application/x-www-form-urlencoded` — não é
 * JSON (confirmado na fonte; ver `docs/MERCADO_LIVRE.md` secao 2.2). Repete
 * em 429 (`local_rate_limited`, específico deste endpoint) e 5xx com o mesmo
 * backoff+jitter do cliente de API — `invalid_client`/`invalid_grant`/etc.
 * (400) não são repetidos.
 */
async function postToken(
  params: Record<string, string>,
  options: RequestTokenOptions,
): Promise<TokenResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;

  const body = new URLSearchParams(params);

  let attempt = 1;

  for (;;) {
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (response.ok) {
      const json: unknown = await response.json();
      return tokenResponseSchema.parse(json);
    }

    const errorClass = classifyStatus(response.status);
    const canRetry = errorClass === "retryable" && attempt < maxAttempts;

    if (!canRetry) {
      const rawBody: unknown = await response.json().catch(() => undefined);
      const parsedError = tokenErrorBodySchema.safeParse(rawBody);
      const message = parsedError.success
        ? `Mercado Livre recusou a troca de token: ${parsedError.data.error}.`
        : `Mercado Livre respondeu ${String(response.status)} na troca de token.`;

      throw new MercadoLivreApiError(message, {
        status: response.status,
        errorClass,
        url: TOKEN_URL,
        body: rawBody,
      });
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
    await sleep(computeBackoffDelayMs({ attempt, retryAfterMs }));
    attempt += 1;
  }
}

/** Troca o `code` do callback OAuth por um `access_token`/`refresh_token`. */
export async function exchangeCodeForToken(
  config: MercadoLivreOAuthConfig,
  code: string,
  requestOptions: RequestTokenOptions = {},
  codeVerifier?: string,
): Promise<TokenResponse> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
  };

  if (codeVerifier !== undefined) {
    params.code_verifier = codeVerifier;
  }

  return postToken(params, requestOptions);
}

/**
 * Renova o `access_token`. O `refresh_token` retornado é NOVO — o chamador
 * precisa persistir o novo par antes do próximo uso, e nunca chamar isto
 * concorrentemente para a mesma conta sem lock (`ml_credentials.refresh_locked_until`),
 * porque o `refresh_token` usado aqui vira inválido assim que a resposta chega.
 */
export async function refreshAccessToken(
  config: MercadoLivreOAuthConfig,
  refreshToken: string,
  requestOptions: RequestTokenOptions = {},
): Promise<TokenResponse> {
  return postToken(
    {
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    },
    requestOptions,
  );
}
