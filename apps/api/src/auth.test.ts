import { describe, expect, it, vi } from "vitest";

import { createAuthenticator, extractBearerToken } from "./auth.js";
import type { AdminClient } from "@sb/db";

/**
 * A recusa de token, e por que a MENSAGEM dela é o que importa aqui (D-300).
 *
 * "token inválido" mandou uma sessão inteira procurar defeito num token que
 * estava perfeito. A causa real era outra: `SUPABASE_URL` exportada no
 * ambiente vence o `.env.local` — `--env-file` do Node não sobrescreve
 * variável existente —, então a web falava com o Supabase local e a `api` com
 * o remoto. Token legítimo, projeto errado.
 *
 * Estes casos existem para que "simplificar" a mensagem de volta seja
 * vermelho, não uma revisão de olho.
 */

/** Cliente mínimo: só o que `createAuthenticator` toca no caminho de recusa. */
function clienteQueRecusa(supabaseUrl: string): AdminClient {
  return {
    supabaseUrl,
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: null }, error: { message: "invalid JWT", status: 401 } }),
    },
  } as unknown as AdminClient;
}

describe("recusa de token (D-300)", () => {
  it("o motivo NOMEIA o Supabase contra o qual validou", async () => {
    const auth = createAuthenticator(clienteQueRecusa("https://projeto-remoto.supabase.co"));

    const resultado = await auth.authenticate("Bearer qualquer-coisa", ["ADMIN"]);

    expect(resultado.ok).toBe(false);

    if (resultado.ok) return;

    expect(resultado.status).toBe(401);
    // O host é o que torna a divergência legível em cinco segundos.
    expect(resultado.reason).toContain("projeto-remoto.supabase.co");
  });

  it("a CHAVE nunca entra no motivo — só o host", async () => {
    const auth = createAuthenticator(clienteQueRecusa("https://projeto-remoto.supabase.co"));

    const resultado = await auth.authenticate("Bearer qualquer-coisa", ["ADMIN"]);

    if (resultado.ok) return;

    // Nem a URL inteira, nem esquema, nem caminho: `host` e mais nada (D-232).
    expect(resultado.reason).not.toContain("https://");
  });

  it("header ausente continua sendo um motivo DIFERENTE do token recusado", async () => {
    // Os dois são 401, e confundi-los mandaria procurar no lugar errado: um é
    // "você não mandou credencial", o outro é "mandei e o projeto não a
    // conhece".
    const auth = createAuthenticator(clienteQueRecusa("https://projeto-remoto.supabase.co"));

    const semHeader = await auth.authenticate(undefined, ["ADMIN"]);

    if (semHeader.ok) return;

    expect(semHeader.reason).toContain("authorization");
    expect(semHeader.reason).not.toContain("projeto-remoto.supabase.co");
  });

  it("URL malformada degrada, nunca derruba o caminho de erro", async () => {
    const auth = createAuthenticator(clienteQueRecusa("nao-e-url"));

    const resultado = await auth.authenticate("Bearer qualquer-coisa", ["ADMIN"]);

    expect(resultado.ok).toBe(false);

    if (resultado.ok) return;

    expect(resultado.status).toBe(401);
    expect(resultado.reason).toContain("desconhecido");
  });
});

function clienteComVinculos(opcoes: {
  authError?: { message: string; status?: number } | null;
  linhas?: { organization_id: string; role: string }[];
  erroVinculos?: { message: string } | null;
}) {
  const getUser = vi.fn(() =>
    opcoes.authError !== undefined && opcoes.authError !== null
      ? Promise.resolve({ data: { user: null }, error: opcoes.authError })
      : Promise.resolve({ data: { user: { id: "user-1" } }, error: null }),
  );
  const linhas = opcoes.linhas ?? [];
  const erroVinculos = opcoes.erroVinculos ?? null;
  let limite = linhas.length;
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    limit: (n: number) => {
      limite = n;
      return cadeia;
    },
    maybeSingle: () =>
      Promise.resolve({
        data: erroVinculos === null ? (linhas[0] ?? null) : null,
        error: erroVinculos,
      }),
    then: (resolve: (v: unknown) => void) => {
      resolve({
        data: erroVinculos === null ? linhas.slice(0, limite) : null,
        error: erroVinculos,
      });
    },
  };

  return {
    db: {
      supabaseUrl: "https://projeto-local.supabase.co",
      auth: { getUser },
      from: () => cadeia,
    } as unknown as AdminClient,
    getUser,
  };
}

describe("endurecimento de autenticação (D-775)", () => {
  it("recusa usuário em múltiplas organizações em vez de escolher uma organização arbitrária", async () => {
    const { db } = clienteComVinculos({
      linhas: [
        { organization_id: "org-1", role: "ADMIN" },
        { organization_id: "org-2", role: "ADMIN" },
      ],
    });
    const auth = createAuthenticator(db);

    const resultado = await auth.authenticate("Bearer token-valido", ["ADMIN"]);

    expect(resultado.ok).toBe(false);
    if (!resultado.ok) {
      expect(resultado.status).toBe(403);
      expect(resultado.reason).toMatch(/mais de uma organização/i);
    }
  });

  it("erro transitório ao consultar organization_members devolve 503 em vez de 403 'sem organização'", async () => {
    const { db } = clienteComVinculos({ erroVinculos: { message: "connection timeout" } });
    const auth = createAuthenticator(db);

    const resultado = await auth.authenticate("Bearer token-valido", ["ADMIN"]);

    expect(resultado).toMatchObject({ ok: false, status: 503 });
  });

  it("erro 5xx/rede no Supabase Auth devolve 503; Bearer só com espaços é recusado antes de chamar o Auth", async () => {
    const indisponivel = clienteComVinculos({ authError: { message: "upstream 503", status: 503 } });
    const resultado = await createAuthenticator(indisponivel.db).authenticate("Bearer token-valido", ["ADMIN"]);

    expect(resultado).toMatchObject({ ok: false, status: 503 });

    const vazio = clienteComVinculos({});
    const espaco = await createAuthenticator(vazio.db).authenticate("Bearer    ", ["ADMIN"]);

    expect(espaco).toMatchObject({ ok: false, status: 401 });
    expect(vazio.getUser).not.toHaveBeenCalled();
    expect(extractBearerToken("Bearer a b")).toBeUndefined();
  });
});
