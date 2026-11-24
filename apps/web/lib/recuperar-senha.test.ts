import { describe, expect, it } from "vitest";

import { desfechoDoPedido, linkDeRetorno, recuperacaoPorEmailLigada } from "./recuperar-senha";

describe("recuperacaoPorEmailLigada (D-863)", () => {
  it("liga só com 1", () => {
    expect(recuperacaoPorEmailLigada("1")).toBe(true);
    expect(recuperacaoPorEmailLigada(" 1 ")).toBe(true);
  });

  it("fica desligada sem a variável ou com outro valor: sem SMTP real o e-mail não chegaria", () => {
    expect(recuperacaoPorEmailLigada(undefined)).toBe(false);
    expect(recuperacaoPorEmailLigada("")).toBe(false);
    expect(recuperacaoPorEmailLigada("0")).toBe(false);
    expect(recuperacaoPorEmailLigada("true")).toBe(false);
  });
});

describe("linkDeRetorno", () => {
  it("volta para a tela de entrada, que lê o fragmento do link", () => {
    expect(linkDeRetorno("https://speedbikers-prod.vercel.app")).toBe("https://speedbikers-prod.vercel.app/login");
    expect(linkDeRetorno("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000/login");
  });
});

describe("desfechoDoPedido", () => {
  it("sem falha é enviado, inclusive para e-mail que não existe (o Auth responde sucesso)", () => {
    expect(desfechoDoPedido(null)).toEqual({ kind: "enviado" });
  });

  it("o limite de envios tem mensagem própria: a ação é esperar", () => {
    for (const falha of [{ status: 429 }, { code: "over_email_send_rate_limit" }, { code: "over_request_rate_limit" }]) {
      expect(desfechoDoPedido(falha)).toEqual({
        kind: "falha",
        mensagem: "Muitos pedidos de link em pouco tempo. Espere alguns minutos e peça de novo.",
      });
    }
  });

  it("qualquer outra falha é genérica e não diz se o e-mail existe", () => {
    const desfecho = desfechoDoPedido({ status: 500, code: "unexpected_failure" });

    expect(desfecho).toEqual({
      kind: "falha",
      mensagem: "Não foi possível pedir o link agora. Tente de novo em alguns minutos.",
    });
  });
});
