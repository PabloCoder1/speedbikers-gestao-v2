import "server-only";

import {
  getMercadoLivreAppConfig,
  type MercadoLivreAppCode,
} from "@/integrations/mercado-livre/config";
import { MERCADO_LIVRE_URLS } from "@/integrations/mercado-livre/constants";

export type MercadoLivreTokenResponse = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string | null;
};

type RawTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
};

export async function exchangeAuthorizationCode({
  appCode,
  code,
  codeVerifier,
}: {
  appCode: MercadoLivreAppCode;
  code: string;
  codeVerifier: string;
}): Promise<MercadoLivreTokenResponse> {
  const config =
    getMercadoLivreAppConfig(
      appCode,
    );

  const body =
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
    });

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

  if (
    !response.ok ||
    !payload
  ) {
    throw new Error(
      "Mercado Livre recusou a troca do authorization code.",
    );
  }

  if (
    typeof payload.access_token !==
      "string" ||
    typeof payload.refresh_token !==
      "string" ||
    typeof payload.expires_in !==
      "number" ||
    payload.expires_in <= 0
  ) {
    throw new Error(
      "Resposta de token do Mercado Livre inválida.",
    );
  }

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
  };
}