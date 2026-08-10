import "server-only";

import {
  getMercadoLivreAppConfig,
  type MercadoLivreAppCode,
} from "./config";
import { MERCADO_LIVRE_URLS } from "./constants";

export type MercadoLivreTokenResponse = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string | null;
  userId: string | null;
};

type RawTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  user_id?: unknown;
  error?: unknown;
  error_description?: unknown;
};

export class MercadoLivreTokenRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    message: string,
  ) {
    super(message);

    this.name =
      "MercadoLivreTokenRequestError";
  }
}

async function requestToken(
  body: URLSearchParams,
): Promise<MercadoLivreTokenResponse> {
  const response = await fetch(
    MERCADO_LIVRE_URLS.token,
    {
      method: "POST",

      headers: {
        Accept:
          "application/json",

        "Content-Type":
          "application/x-www-form-urlencoded",
      },

      body,

      cache: "no-store",
    },
  );

  let payload:
    | RawTokenResponse
    | null = null;

  try {
    payload =
      (await response.json()) as
        RawTokenResponse;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const code =
      typeof payload?.error ===
      "string"
        ? payload.error
        : null;

    const description =
      typeof payload
        ?.error_description ===
      "string"
        ? payload
            .error_description
        : "Mercado Livre recusou a solicitação de token.";

    throw new MercadoLivreTokenRequestError(
      response.status,
      code,
      description,
    );
  }

  if (
    !payload ||
    typeof payload.access_token !==
      "string" ||
    typeof payload.refresh_token !==
      "string" ||
    typeof payload.expires_in !==
      "number" ||
    payload.expires_in <= 0
  ) {
    throw new MercadoLivreTokenRequestError(
      response.status,
      null,
      "Resposta de token do Mercado Livre inválida.",
    );
  }

  const rawUserId =
    payload.user_id;

  return {
    accessToken:
      payload.access_token,

    refreshToken:
      payload.refresh_token,

    tokenType:
      typeof payload.token_type ===
      "string"
        ? payload.token_type
        : "bearer",

    expiresIn:
      payload.expires_in,

    scope:
      typeof payload.scope ===
      "string"
        ? payload.scope
        : null,

    userId:
      typeof rawUserId ===
        "string" ||
      typeof rawUserId ===
        "number"
        ? String(rawUserId)
        : null,
  };
}

export async function exchangeAuthorizationCode({
  appCode,
  code,
  codeVerifier,
}: {
  appCode: MercadoLivreAppCode;
  code: string;
  codeVerifier: string;
}) {
  const config =
    getMercadoLivreAppConfig(
      appCode,
    );

  return requestToken(
    new URLSearchParams({
      grant_type:
        "authorization_code",

      client_id:
        config.clientId,

      client_secret:
        config.clientSecret,

      code,

      redirect_uri:
        config.redirectUri,

      code_verifier:
        codeVerifier,
    }),
  );
}

export async function refreshAccessToken({
  appCode,
  refreshToken,
}: {
  appCode: MercadoLivreAppCode;
  refreshToken: string;
}) {
  const config =
    getMercadoLivreAppConfig(
      appCode,
    );

  return requestToken(
    new URLSearchParams({
      grant_type:
        "refresh_token",

      client_id:
        config.clientId,

      client_secret:
        config.clientSecret,

      refresh_token:
        refreshToken,
    }),
  );
}