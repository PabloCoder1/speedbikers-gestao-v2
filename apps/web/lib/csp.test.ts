import { describe, expect, it } from "vitest";

import { gerarNonce, montarCsp } from "./csp.js";

function diretiva(csp: string, nome: string): string | undefined {
  return csp
    .split(";")
    .map((parte) => parte.trim())
    .find((parte) => parte.startsWith(`${nome} `));
}

/**
 * A CSP com nonce (D-331). O que cada caso fixa é uma decisão medida — e o
 * desvio dela quebra a aplicação sem aviso, que é por que precisa de teste.
 */
describe("montarCsp", () => {
  const base = {
    nonce: "abc123",
    supabaseUrl: "https://projeto.supabase.co",
    apiUrl: "https://api.exemplo.run.app",
    dev: false,
  };

  it("script-src carrega o nonce e strict-dynamic, e nada de unsafe-inline", () => {
    const script = diretiva(montarCsp(base), "script-src");

    expect(script).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
  });

  it("style-src aceita inline — nonce não autoriza atributo style, e a tela tem 999", () => {
    expect(diretiva(montarCsp(base), "style-src")).toBe("style-src 'self' 'unsafe-inline'");
  });

  it("connect-src leva o Supabase em HTTPS e em WebSocket, e a api", () => {
    const conectar = diretiva(montarCsp(base), "connect-src");

    expect(conectar).toBe(
      "connect-src 'self' https://projeto.supabase.co wss://projeto.supabase.co https://api.exemplo.run.app",
    );
  });

  it("img-src abre o Supabase (fotos de perfil, D-354) e o CDN do Mercado Livre (miniatura do anúncio)", () => {
    expect(diretiva(montarCsp(base), "img-src")).toBe(
      "img-src 'self' data: blob: https://projeto.supabase.co https://*.mlstatic.com",
    );
    expect(diretiva(montarCsp({ ...base, supabaseUrl: "" }), "img-src")).toBe(
      "img-src 'self' data: blob: https://*.mlstatic.com",
    );
  });

  it("no ambiente local, http vira ws — é o Realtime do Supabase da suíte", () => {
    const conectar = diretiva(montarCsp({ ...base, supabaseUrl: "http://127.0.0.1:54321" }), "connect-src");

    expect(conectar).toContain("http://127.0.0.1:54321");
    expect(conectar).toContain("ws://127.0.0.1:54321");
  });

  it("variável vazia ou inválida some da lista, e nunca vira 'null'", () => {
    const csp = montarCsp({ ...base, supabaseUrl: "", apiUrl: "não é url" });

    expect(diretiva(csp, "connect-src")).toBe("connect-src 'self'");
    expect(csp).not.toContain("null");
  });

  it("unsafe-eval e ws: só em desenvolvimento", () => {
    expect(montarCsp(base)).not.toContain("unsafe-eval");
    expect(diretiva(montarCsp(base), "connect-src")).not.toContain("ws:");

    const dev = montarCsp({ ...base, dev: true });

    expect(diretiva(dev, "script-src")).toContain("'unsafe-eval'");
    expect(diretiva(dev, "connect-src")).toContain("ws:");
  });

  it("fecha o que não é usado, e continua negando moldura", () => {
    const csp = montarCsp(base);

    expect(diretiva(csp, "object-src")).toBe("object-src 'none'");
    expect(diretiva(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(diretiva(csp, "base-uri")).toBe("base-uri 'self'");
    expect(diretiva(csp, "form-action")).toBe("form-action 'self'");
  });

  it("não traz upgrade-insecure-requests — quebraria o Supabase local em http", () => {
    expect(montarCsp(base)).not.toContain("upgrade-insecure-requests");
  });
});

describe("gerarNonce", () => {
  it("é diferente a cada chamada e cabe numa diretiva", () => {
    const a = gerarNonce();
    const b = gerarNonce();

    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/=]{20,}$/);
  });
});
