import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn<() => Promise<{ data: { session: { access_token: string } | null } }>>();

vi.mock("./supabase/browser", () => ({
  createClient: () => ({
    auth: {
      getSession: getSessionMock,
    },
  }),
}));

import {
  chamarApi,
  confirmarAplicacaoNaApi,
  extrairNarrativaDoCopiloto,
  lerTokenDeSessao,
  respostaDeRepublicacaoValida,
} from "./chamar-api";

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

  it("D-781: confirmarAplicacaoNaApi recusa 200 HTML ou JSON sem queued=true e aceita confirmação válida", async () => {
    process.env.NEXT_PUBLIC_API_URL = "http://api.local";
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "tok-1" } } });

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("<html><body>login</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ documentId: "doc-1", queued: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    expect(await confirmarAplicacaoNaApi("/v1/nfe-imports/doc-1/apply")).toEqual({
      ok: false,
      mensagem: "A API respondeu em formato inesperado. Confira se a aplicação foi iniciada.",
    });
    expect(await confirmarAplicacaoNaApi("/v1/nfe-imports/doc-1/apply")).toEqual({
      ok: false,
      mensagem: "A API respondeu em formato inesperado. Confira se a aplicação foi iniciada.",
    });
    expect(await confirmarAplicacaoNaApi("/v1/nfe-imports/doc-1/apply")).toEqual({ ok: true });
  });

  it("D-781: extrairNarrativaDoCopiloto e respostaDeRepublicacaoValida validam corpo de 200 OK", () => {
    expect(extrairNarrativaDoCopiloto({ data: { narrativa: "Queda causada por ruptura." } })).toBe(
      "Queda causada por ruptura.",
    );
    expect(extrairNarrativaDoCopiloto(null)).toBeNull();
    expect(extrairNarrativaDoCopiloto({})).toBeNull();
    expect(extrairNarrativaDoCopiloto({ data: {} })).toBeNull();
    expect(extrairNarrativaDoCopiloto({ data: { narrativa: "   " } })).toBeNull();
    expect(extrairNarrativaDoCopiloto({ data: { narrativa: 42 } })).toBeNull();

    expect(respostaDeRepublicacaoValida({ status: "queued", deduplicated: false })).toBe(true);
    expect(respostaDeRepublicacaoValida(null)).toBe(false);
    expect(respostaDeRepublicacaoValida({})).toBe(false);
    expect(respostaDeRepublicacaoValida({ status: "error" })).toBe(false);
  });

  it("D-781: action-card, relist-panel e diagnosis-panel usam lerTokenDeSessao sem getSession direto", () => {
    const arquivos = [
      "app/(app)/acoes/action-card.tsx",
      "app/(app)/anuncios/[itemId]/relist-panel.tsx",
      "app/(app)/skus/[skuId]/diagnosis-panel.tsx",
    ];

    for (const rel of arquivos) {
      const codigo = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(codigo, rel).not.toContain(".auth.getSession(");
      expect(codigo, rel).toContain("lerTokenDeSessao");
    }
  });
});
