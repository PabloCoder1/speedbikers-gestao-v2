import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createMercadoLivreClient } from "./http-client.js";
import { refreshAccessToken } from "./oauth.js";

/** Um `fetch` que nunca responde: só termina quando o sinal aborta. */
const fetchParado = ((_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error("abortado"));
    });
  })) as typeof fetch;

describe("teto de tempo por tentativa (auditoria de 2026-09-28)", () => {
  it("a chamada da API desiste quando a conexão para de responder", async () => {
    const client = createMercadoLivreClient({ fetchImpl: fetchParado, requestTimeoutMs: 20 });

    await expect(client.request({ method: "GET", path: "/users/me", schema: z.unknown() })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("a troca de token também", async () => {
    await expect(
      refreshAccessToken({ clientId: "APP_ID", clientSecret: "segredo-de-teste", redirectUri: "" }, "TG-x", {
        fetchImpl: fetchParado,
        requestTimeoutMs: 20,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
