import { describe, expect, it, vi } from "vitest";

import { createMercadoLivreClient } from "./http-client.js";
import { getItemDescription } from "./description.js";

function clienteCom(status: number, corpo: unknown, captura: { url?: URL } = {}) {
  const fetchImpl = vi.fn((url: string | URL | Request) => {
    captura.url = new URL(url as string | URL);

    return Promise.resolve(new Response(JSON.stringify(corpo), { status }));
  });

  return createMercadoLivreClient({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: () => Promise.resolve() });
}

describe("getItemDescription", () => {
  it("monta a chamada no recurso próprio de descrição", async () => {
    const captura: { url?: URL } = {};
    const client = clienteCom(200, { text: "", plain_text: "Descrição real do anúncio." }, captura);

    await getItemDescription({ client, itemId: "MLB1384467402", accessToken: "APP_USR-teste" });

    expect(captura.url?.pathname).toBe("/items/MLB1384467402/description");
  });

  it("devolve plain_text (exemplo real, 2026-09-21) — não `text`, que veio vazio", async () => {
    const client = clienteCom(200, {
      text: "",
      plain_text: "A Polia Traseira Completa da TMAC ...",
      last_updated: "2024-09-20T19:39:32.999Z",
      date_created: "2019-12-09T13:13:47.000Z",
      snapshot: { url: "http://descriptions.mlstatic.com/D-MLB1384467402.jpg", width: 0, height: 0, status: "" },
    });

    await expect(
      getItemDescription({ client, itemId: "MLB1384467402", accessToken: "APP_USR-teste" }),
    ).resolves.toBe("A Polia Traseira Completa da TMAC ...");
  });

  it("404 (sem descrição própria) vira null, não erro", async () => {
    const client = clienteCom(404, { message: "not found", error: "not_found", status: 404 });

    await expect(
      getItemDescription({ client, itemId: "MLB999", accessToken: "APP_USR-teste" }),
    ).resolves.toBeNull();
  });

  it("outro erro (ex.: 500) continua sendo erro — só 404 é silencioso", async () => {
    const client = clienteCom(500, { message: "erro interno" });

    await expect(
      getItemDescription({ client, itemId: "MLB999", accessToken: "APP_USR-teste" }),
    ).rejects.toThrow();
  });
});
