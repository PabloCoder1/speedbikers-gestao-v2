import { describe, expect, it } from "vitest";

import { createAuthenticator } from "./auth.js";
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
