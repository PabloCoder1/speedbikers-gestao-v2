import { describe, expect, it, vi } from "vitest";

import { MercadoLivreApiError } from "./errors.js";
import {
  buildAuthorizationUrl,
  createPkcePair,
  exchangeCodeForToken,
  refreshAccessToken,
} from "./oauth.js";

const CONFIG = {
  clientId: "APP_ID_123",
  clientSecret: "SEGREDO_QUE_NAO_PODE_VAZAR",
  redirectUri: "https://speedbikers.example/oauth/callback",
};

const TOKEN_RESPONSE_BODY = {
  access_token: "APP_USR-123456-090515-abcdef-1234567",
  token_type: "bearer",
  expires_in: 21_600,
  scope: "offline_access read write",
  user_id: 1234567,
  refresh_token: "TG-5b9032b4e23464aed1f959f-1234567",
};

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const NOOP_SLEEP = async (): Promise<void> => {
  /* sem atraso real em teste */
};

describe("createPkcePair", () => {
  it("gera verifier/challenge base64url válidos e relacionados por SHA-256", async () => {
    const { createHash } = await import("node:crypto");
    const pair = createPkcePair();

    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.codeChallenge).toBe(
      createHash("sha256").update(pair.codeVerifier, "ascii").digest("base64url"),
    );
    expect(pair.codeChallengeMethod).toBe("S256");
  });

  it("não reutiliza verifier entre autorizações", () => {
    expect(createPkcePair().codeVerifier).not.toBe(createPkcePair().codeVerifier);
  });
});

describe("buildAuthorizationUrl", () => {
  it("monta a URL de autorização no domínio brasileiro com os parâmetros obrigatórios", () => {
    const url = new URL(buildAuthorizationUrl(CONFIG, { state: "estado-aleatorio-123" }));

    expect(url.origin + url.pathname).toBe("https://auth.mercadolivre.com.br/authorization");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("state")).toBe("estado-aleatorio-123");
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });

  it("inclui code_challenge/code_challenge_method quando PKCE está habilitado", () => {
    const url = new URL(
      buildAuthorizationUrl(CONFIG, {
        state: "estado",
        codeChallenge: "challenge-123",
        codeChallengeMethod: "S256",
      }),
    );

    expect(url.searchParams.get("code_challenge")).toBe("challenge-123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("exchangeCodeForToken", () => {
  it("faz POST form-urlencoded com os campos exatos e devolve o token tipado", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
      expect(headers.accept).toBe("application/json");

      const body = new URLSearchParams(init?.body as string);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_id")).toBe(CONFIG.clientId);
      expect(body.get("client_secret")).toBe(CONFIG.clientSecret);
      expect(body.get("code")).toBe("TG-codigo-de-autorizacao");
      expect(body.get("redirect_uri")).toBe(CONFIG.redirectUri);

      return Promise.resolve(jsonResponse(200, TOKEN_RESPONSE_BODY));
    });

    const token = await exchangeCodeForToken(CONFIG, "TG-codigo-de-autorizacao", { fetchImpl });

    expect(token.access_token).toBe(TOKEN_RESPONSE_BODY.access_token);
    expect(token.refresh_token).toBe(TOKEN_RESPONSE_BODY.refresh_token);
    expect(token.expires_in).toBe(21_600);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("inclui code_verifier quando fornecido (fluxo PKCE)", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(init?.body as string);
      expect(body.get("code_verifier")).toBe("verifier-123");
      return Promise.resolve(jsonResponse(200, TOKEN_RESPONSE_BODY));
    });

    await exchangeCodeForToken(CONFIG, "codigo", { fetchImpl }, "verifier-123");
  });

  it("lança MercadoLivreApiError não retryable em invalid_grant (400), numa única tentativa", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse(400, {
          error: "invalid_grant",
          error_description:
            "Error validating grant. Your authorization code or refresh token may be expired or it was already used",
          status: 400,
          cause: [],
        }),
      ),
    );

    await expect(exchangeCodeForToken(CONFIG, "codigo-expirado", { fetchImpl })).rejects.toThrow(
      MercadoLivreApiError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("repete em local_rate_limited (429) e sucede na tentativa seguinte", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "local_rate_limited" }))
      .mockResolvedValueOnce(jsonResponse(200, TOKEN_RESPONSE_BODY));

    const token = await exchangeCodeForToken(CONFIG, "codigo", {
      fetchImpl,
      sleep: NOOP_SLEEP,
    });

    expect(token.access_token).toBe(TOKEN_RESPONSE_BODY.access_token);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("nunca deixa o client_secret vazar na mensagem nem no corpo do erro lançado", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(400, { error: "invalid_client", error_description: "bad credentials" })),
    );

    try {
      await exchangeCodeForToken(CONFIG, "codigo", { fetchImpl });
      expect.unreachable("deveria ter lançado MercadoLivreApiError");
    } catch (error) {
      expect(error).toBeInstanceOf(MercadoLivreApiError);
      const serializado = JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
        body: error instanceof MercadoLivreApiError ? error.body : undefined,
      });

      expect(serializado).not.toContain(CONFIG.clientSecret);
    }
  });
});

describe("refreshAccessToken", () => {
  it("faz POST com grant_type=refresh_token e os campos exatos", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(init?.body as string);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("TG-refresh-antigo");
      expect(body.has("code")).toBe(false);

      return Promise.resolve(jsonResponse(200, TOKEN_RESPONSE_BODY));
    });

    const token = await refreshAccessToken(CONFIG, "TG-refresh-antigo", { fetchImpl });

    expect(token.refresh_token).toBe(TOKEN_RESPONSE_BODY.refresh_token);
  });

  it("nunca deixa o refresh_token usado vazar no erro quando a chamada falha", async () => {
    const segredo = "TG-refresh-QUE-NAO-PODE-VAZAR";
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(400, { error: "invalid_grant" })));

    try {
      await refreshAccessToken(CONFIG, segredo, { fetchImpl });
      expect.unreachable("deveria ter lançado MercadoLivreApiError");
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : String(error);
      expect(mensagem).not.toContain(segredo);
    }
  });
});
