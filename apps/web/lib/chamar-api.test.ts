import { afterEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn<() => Promise<{ data: { session: { access_token: string } | null } }>>();

vi.mock("./supabase/browser", () => ({
  createClient: () => ({
    auth: {
      getSession: getSessionMock,
    },
  }),
}));

import { chamarApi, confirmarAplicacaoNaApi, lerTokenDeSessao } from "./chamar-api";

describe("chamar-api / lerTokenDeSessao (D-741, D-745)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getSessionMock.mockReset();
    delete process.env.NEXT_PUBLIC_API_URL;
  });

  it("lerTokenDeSessao devolve erro controlado quando getSession rejeita", async () => {
    getSessionMock.mockRejectedValueOnce(new Error("storage unavailable"));

    const result = await lerTokenDeSessao();

    expect(result).toEqual({
      ok: false,
      mensagem: "Não foi possível ler sua sessão. Entre de novo.",
    });
  });

  it("lerTokenDeSessao respeita mensagem customizada quando não há sessão", async () => {
    getSessionMock.mockResolvedValueOnce({ data: { session: null } });

    const result = await lerTokenDeSessao("Sua sessão expirou. Entre de novo.");

    expect(result).toEqual({
      ok: false,
      mensagem: "Sua sessão expirou. Entre de novo.",
    });
  });

  it("confirmarAplicacaoNaApi não propaga exceção quando getSession falha", async () => {
    getSessionMock.mockRejectedValueOnce(new Error("IndexedDB blocked"));

    const result = await confirmarAplicacaoNaApi("/v1/erp-imports/123/apply");

    expect(result).toEqual({
      ok: false,
      mensagem: "Não foi possível ler sua sessão. Entre de novo.",
    });
  });

  it("chamarApi recupera resposta 200 sem JSON válido sem lançar exceção", async () => {
    process.env.NEXT_PUBLIC_API_URL = "http://api.local";
    getSessionMock.mockResolvedValueOnce({ data: { session: { access_token: "tok-1" } } });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<html>bad gateway</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );

    const result = await chamarApi<{ ok: boolean }>("/v1/teste", { a: 1 });

    expect(result).toEqual({
      ok: false,
      mensagem: "A API respondeu sem corpo.",
    });
  });
});
