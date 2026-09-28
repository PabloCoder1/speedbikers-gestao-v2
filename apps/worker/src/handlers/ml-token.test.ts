import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TokenDeps } from "./ml-token.js";
import { ensureAccessToken } from "./ml-token.js";

const CONTA = "aaaaaaaa-0000-4000-8000-000000000001";
const CHAVE = randomBytes(32);
const AGORA = new Date("2026-09-27T03:30:00.000Z");
const OAUTH = { clientId: "APP_ID_123", clientSecret: "segredo-de-teste", redirectUri: "" };

/** Credencial a um minuto de vencer: dentro da margem, a execução tenta renovar. */
const VENCENDO = {
  access_token_ciphertext: encryptToken("APP_USR-velho", CHAVE),
  refresh_token_ciphertext: encryptToken("TG-velho", CHAVE),
  access_token_expires_at: new Date(AGORA.getTime() + 60_000).toISOString(),
};

function fakeDb(): { deps: TokenDeps; atualizacoes: { table: string; row: Record<string, unknown> }[] } {
  const atualizacoes: { table: string; row: Record<string, unknown> }[] = [];

  const cadeia = (resultado: { data: unknown; error: null }) => {
    const self = {
      eq: () => self,
      or: () => self,
      select: () => self,
      maybeSingle: () => Promise.resolve(resultado),
      then: <R>(resolve: (value: { data: unknown; error: null }) => R) => Promise.resolve(resultado).then(resolve),
    };

    return self;
  };

  const db = {
    from: (table: string) => ({
      select: () => cadeia({ data: table === "ml_credentials" ? VENCENDO : null, error: null }),
      // A trava é reivindicada com sucesso; as outras atualizações só são registradas.
      update: (row: Record<string, unknown>) => {
        atualizacoes.push({ table, row });

        return cadeia({ data: table === "ml_credentials" ? { ml_account_id: CONTA } : null, error: null });
      },
    }),
  } as unknown as TokenDeps["db"];

  return { deps: { db, oauth: OAUTH, encryptionKey: CHAVE }, atualizacoes };
}

function respostaDoToken(status: number, corpo: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(corpo === undefined ? "" : JSON.stringify(corpo), {
          status,
          headers: corpo === undefined ? {} : { "content-type": "application/json" },
        }),
      ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureAccessToken: só a recusa definitiva derruba a conta (incidente de 27/09)", () => {
  it("403 sem corpo -- o bloqueio da saída de uma instância: nova tentativa, a conta continua CONNECTED", async () => {
    respostaDoToken(403, undefined);
    const { deps, atualizacoes } = fakeDb();

    const resultado = await ensureAccessToken(deps, CONTA, AGORA);

    expect(resultado).toEqual({ ok: false, retryable: true, reason: "Mercado Livre respondeu 403 na troca de token." });
    expect(atualizacoes.some((a) => a.table === "ml_accounts")).toBe(false);
    // A trava é solta, para a próxima execução poder tentar.
    expect(atualizacoes.at(-1)).toEqual({ table: "ml_credentials", row: { refresh_locked_until: null } });
  });

  it("403 do PolicyAgent, com JSON mas sem erro OAuth: também passageiro", async () => {
    respostaDoToken(403, {
      code: "PA_UNAUTHORIZED_RESULT_FROM_POLICIES",
      blocked_by: "PolicyAgent",
      message: "At least one policy returned UNAUTHORIZED.",
      status: 403,
    });
    const { deps, atualizacoes } = fakeDb();

    await expect(ensureAccessToken(deps, CONTA, AGORA)).resolves.toMatchObject({ ok: false, retryable: true });
    expect(atualizacoes.some((a) => a.table === "ml_accounts")).toBe(false);
  });

  it("falha de rede: passageira", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("fetch failed"))));
    const { deps, atualizacoes } = fakeDb();

    await expect(ensureAccessToken(deps, CONTA, AGORA)).resolves.toEqual({
      ok: false,
      retryable: true,
      reason: "fetch failed",
    });
    expect(atualizacoes.some((a) => a.table === "ml_accounts")).toBe(false);
  });

  it("400 invalid_grant -- o refresh token não vale mais: ERROR, e é preciso reconectar", async () => {
    respostaDoToken(400, { error: "invalid_grant", error_description: "Error validating grant.", status: 400, cause: [] });
    const { deps, atualizacoes } = fakeDb();

    const resultado = await ensureAccessToken(deps, CONTA, AGORA);

    expect(resultado).toEqual({
      ok: false,
      retryable: false,
      reason: "Mercado Livre recusou a troca de token: invalid_grant.",
    });
    expect(atualizacoes.find((a) => a.table === "ml_accounts")?.row).toEqual({
      status: "ERROR",
      last_error: "Mercado Livre recusou a troca de token: invalid_grant.",
    });
  });

  it("401 invalid_client -- credencial do app recusada: ERROR", async () => {
    respostaDoToken(401, { error: "invalid_client", status: 401 });
    const { deps, atualizacoes } = fakeDb();

    await expect(ensureAccessToken(deps, CONTA, AGORA)).resolves.toMatchObject({ ok: false, retryable: false });
    expect(atualizacoes.find((a) => a.table === "ml_accounts")?.row).toMatchObject({ status: "ERROR" });
  });
});
