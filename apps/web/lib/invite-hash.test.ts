import { describe, expect, it } from "vitest";

import { lerConviteDaUrl } from "./invite-hash";

/**
 * O que o link de convite deixa na URL (D-302).
 *
 * O fragmento REAL, copiado da medição de 2026-09-10 seguindo um convite de
 * verdade até o navegador. Os tokens estão truncados; o formato é o que
 * importa.
 */
const REAL =
  "#access_token=eyJhbGciOiJFUzI1NiIsImtpZCI6ImI4MTI2OWYx&expires_at=1789062219&expires_in=3600" +
  "&refresh_token=su3dvhtyshb2&sb=&token_type=bearer&type=invite";

describe("lerConviteDaUrl (D-302)", () => {
  it("lê o fragmento que o convite de verdade deixou", () => {
    expect(lerConviteDaUrl(REAL)).toEqual({
      kind: "sessao",
      accessToken: "eyJhbGciOiJFUzI1NiIsImtpZCI6ImI4MTI2OWYx",
      refreshToken: "su3dvhtyshb2",
      tipo: "invite",
    });
  });

  it("recovery entra pela mesma porta: os dois terminam em definir senha", () => {
    const achado = lerConviteDaUrl("#access_token=a&refresh_token=b&type=recovery");

    expect(achado).toEqual({ kind: "sessao", accessToken: "a", refreshToken: "b", tipo: "recovery" });
  });

  /*
    A RECUSA QUE JUSTIFICA O MÓDULO. `magiclink` também traz sessão pelo
    fragmento, e quem chega por ele JÁ ESTÁ dentro — pedir senha ali seria uma
    tela de "defina sua senha" aparecendo para quem não pediu nada.
  */
  it("magiclink NÃO abre a tela de definir senha", () => {
    expect(lerConviteDaUrl("#access_token=a&refresh_token=b&type=magiclink")).toBeNull();
    expect(lerConviteDaUrl("#access_token=a&refresh_token=b&type=signup")).toBeNull();
    expect(lerConviteDaUrl("#access_token=a&refresh_token=b")).toBeNull();
  });

  it("meia sessão não se usa", () => {
    expect(lerConviteDaUrl("#access_token=a&type=invite")).toBeNull();
    expect(lerConviteDaUrl("#refresh_token=b&type=invite")).toBeNull();
    expect(lerConviteDaUrl("#access_token=&refresh_token=&type=invite")).toBeNull();
  });

  /**
   * Link vencido ou já usado. Sem este ramo a tela mostraria o formulário de
   * entrada como se nada tivesse acontecido, e a pessoa tentaria uma senha que
   * nunca definiu — que é exatamente a pergunta que abriu esta fatia.
   */
  it("link vencido é DITO, não confundido com entrada normal", () => {
    const achado = lerConviteDaUrl(
      "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );

    expect(achado).toEqual({ kind: "expirado", descricao: "Email link is invalid or has expired" });
  });

  it("erro sem descrição continua sendo erro — a tela tem a própria frase", () => {
    expect(lerConviteDaUrl("#error=access_denied")).toEqual({ kind: "expirado", descricao: "" });
  });

  it("entrada normal (sem fragmento) não vira nada", () => {
    expect(lerConviteDaUrl("")).toBeNull();
    expect(lerConviteDaUrl("#")).toBeNull();
  });
});
