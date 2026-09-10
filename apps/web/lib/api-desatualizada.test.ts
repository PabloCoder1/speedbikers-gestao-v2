import { afterEach, describe, expect, it, vi } from "vitest";

import { explicar404 } from "./api-desatualizada.js";

/**
 * O diagnóstico de "a API no ar é mais velha que a tela" (D-301).
 *
 * Estes casos guardam duas coisas: que a frase NOMEIA o commit quando `/health`
 * responde, e que ela **não inventa nada** quando não responde — que é a
 * diferença entre diagnóstico e chute.
 */

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
});

function responderSaude(corpo: unknown, ok = true): void {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({ ok, json: () => Promise.resolve(corpo) } as Response),
  );
}

describe("explicar404 (D-301)", () => {
  it("NOMEIA o commit que está no ar — é o que separa diagnóstico de chute", async () => {
    responderSaude({ status: "ok", commit: "6baa641", startedAt: "2026-09-07T13:18:48.215Z" });

    const frase = await explicar404("https://api.exemplo.app");

    expect(frase).toContain("https://api.exemplo.app");
    expect(frase).toContain("6baa641");
    expect(frase).toContain("deploy do Cloud Run é manual");
  });

  it("sem commit no /health, diz o que sabe e PARA — não inventa versão", async () => {
    // Local, por exemplo: `APP_COMMIT` não existe e o health devolve `null`.
    responderSaude({ status: "ok", commit: null });

    const frase = await explicar404("http://127.0.0.1:8080");

    expect(frase).toContain("não conhece esta rota");
    expect(frase).not.toContain("commit ");
  });

  it("se /health não responde, a frase encurta em vez de quebrar", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("sem rede")));

    const frase = await explicar404("https://api.exemplo.app");

    expect(frase).toContain("não conhece esta rota");
    expect(frase).toContain("anterior a esta tela");
  });

  it("/health com erro HTTP também degrada — `ok: false` não vira commit", async () => {
    responderSaude({ commit: "naoDeveriaAparecer" }, false);

    const frase = await explicar404("https://api.exemplo.app");

    expect(frase).not.toContain("naoDeveriaAparecer");
  });

  it("data ilegível não derruba a frase, só some dela", async () => {
    responderSaude({ commit: "abc1234", startedAt: "isto-nao-e-data" });

    const frase = await explicar404("https://api.exemplo.app");

    expect(frase).toContain("abc1234");
    expect(frase).not.toContain("no ar desde");
  });
});
