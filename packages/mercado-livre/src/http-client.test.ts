import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { MercadoLivreApiError } from "./errors.js";
import { createMercadoLivreClient } from "./http-client.js";

const orderSchema = z.object({ id: z.number(), status: z.string() });

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const NOOP_SLEEP = async (): Promise<void> => {
  /* sem atraso real em teste */
};

describe("createMercadoLivreClient - onFailure (incidente de 25/09)", () => {
  it("entrega o corpo da resposta de erro final, uma vez, depois das novas tentativas", async () => {
    const falhas: unknown[] = [];
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(403, { message: "forbidden", error: "forbidden", status: 403, cause: [] })),
    );
    const client = createMercadoLivreClient({ fetchImpl, sleep: NOOP_SLEEP, onFailure: (f) => falhas.push(f) });

    await expect(client.request({ method: "GET", path: "/orders/1", accessToken: "t", schema: orderSchema })).rejects.toThrow(
      "Mercado Livre respondeu 403 para GET /orders/1.",
    );
    expect(falhas).toEqual([
      {
        status: 403,
        method: "GET",
        path: "/orders/1",
        errorClass: "not_retryable",
        body: { message: "forbidden", error: "forbidden", status: 403, cause: [] },
      },
    ]);
  });

  it("não é chamado quando a resposta é boa, e se ele lançar a chamada falha pelo motivo de sempre", async () => {
    const onFailure = vi.fn(() => {
      throw new Error("log quebrado");
    });
    const ok = createMercadoLivreClient({
      fetchImpl: () => Promise.resolve(jsonResponse(200, { id: 1, status: "paid" })),
      onFailure,
    });

    await ok.request({ method: "GET", path: "/orders/1", schema: orderSchema });
    expect(onFailure).not.toHaveBeenCalled();

    const falha = createMercadoLivreClient({
      fetchImpl: () => Promise.resolve(jsonResponse(404, { message: "not found" })),
      onFailure,
    });

    await expect(falha.request({ method: "GET", path: "/orders/2", schema: orderSchema })).rejects.toBeInstanceOf(
      MercadoLivreApiError,
    );
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});

describe("createMercadoLivreClient - request", () => {
  it("faz GET autenticado, com querystring e schema validando a resposta", async () => {
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(url as string | URL);
      expect(parsed.pathname).toBe("/orders/123");
      expect(parsed.searchParams.get("access_token_hint")).toBeNull();

      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer APP_USR-token-da-conta");

      return Promise.resolve(jsonResponse(200, { id: 123, status: "paid" }));
    });

    const client = createMercadoLivreClient({ fetchImpl });
    const order = await client.request({
      method: "GET",
      path: "/orders/123",
      accessToken: "APP_USR-token-da-conta",
      schema: orderSchema,
    });

    expect(order).toEqual({ id: 123, status: "paid" });
  });

  it("omite o header Authorization quando accessToken não é passado (chamada pública)", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBeUndefined();
      return Promise.resolve(jsonResponse(200, { id: 1, status: "active" }));
    });

    const client = createMercadoLivreClient({ fetchImpl });
    await client.request({ method: "GET", path: "/products/search", schema: orderSchema });
  });

  it("aplica os searchParams na URL, ignorando valores undefined", async () => {
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      const parsed = new URL(url as string | URL);
      expect(parsed.searchParams.get("seller")).toBe("999");
      expect(parsed.searchParams.has("offset")).toBe(false);
      return Promise.resolve(jsonResponse(200, { id: 1, status: "paid" }));
    });

    const client = createMercadoLivreClient({ fetchImpl });
    await client.request({
      method: "GET",
      path: "/orders/search",
      searchParams: { seller: 999, offset: undefined },
      schema: orderSchema,
    });
  });

  it("repete em 429 e 5xx até suceder, honrando backoff", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { message: "rate limited" }))
      .mockResolvedValueOnce(jsonResponse(503, { message: "unavailable" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 1, status: "paid" }));

    const client = createMercadoLivreClient({ fetchImpl, sleep: NOOP_SLEEP });
    const order = await client.request({ method: "GET", path: "/orders/1", schema: orderSchema });

    expect(order.status).toBe("paid");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("desiste após maxAttempts em erro retryable e lança MercadoLivreApiError", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(503, { message: "unavailable" })));

    const client = createMercadoLivreClient({ fetchImpl, sleep: NOOP_SLEEP, maxAttempts: 2 });

    await expect(
      client.request({ method: "GET", path: "/orders/1", schema: orderSchema }),
    ).rejects.toThrow(MercadoLivreApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maxAttempts: 1 na CHAMADA não repete 5xx nem 429 — o erro é o da única tentativa (POST /relist, D-364)", async () => {
    for (const status of [503, 429]) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(status, { message: "instável" }))
        .mockResolvedValueOnce(jsonResponse(400, { message: "item already relisted" }));

      const client = createMercadoLivreClient({ fetchImpl, sleep: NOOP_SLEEP });

      await expect(
        client.request({ method: "POST", path: "/items/MLB1/relist", body: {}, schema: orderSchema, maxAttempts: 1 }),
      ).rejects.toMatchObject({ status, errorClass: "retryable" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("sem maxAttempts na chamada, vale o teto do cliente — o mesmo cliente segue repetindo as outras", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { message: "instável" }))
      .mockResolvedValueOnce(jsonResponse(503, { message: "instável" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 1, status: "paid" }));

    const client = createMercadoLivreClient({ fetchImpl, sleep: NOOP_SLEEP, maxAttempts: 3 });

    await expect(client.request({ method: "GET", path: "/orders/1", schema: orderSchema })).resolves.toMatchObject({
      status: "paid",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("não repete erro not_retryable (ex.: 401) — falha na primeira tentativa", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(401, { message: "invalid token" })));

    const client = createMercadoLivreClient({ fetchImpl, sleep: NOOP_SLEEP });

    await expect(
      client.request({ method: "GET", path: "/orders/1", schema: orderSchema }),
    ).rejects.toMatchObject({ errorClass: "not_retryable", status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("404 só é retryable_eventual quando o chamador sinaliza tolerância, com teto próprio", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(404, { message: "not found yet" })));

    const client = createMercadoLivreClient({
      fetchImpl,
      sleep: NOOP_SLEEP,
      eventualMaxAttempts: 2,
    });

    await expect(
      client.request({
        method: "GET",
        path: "/orders/1",
        schema: orderSchema,
        eventualConsistencyTolerant: true,
      }),
    ).rejects.toMatchObject({ errorClass: "retryable_eventual" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("sem o sinalizador de tolerância, 404 não é retryable e falha na primeira tentativa", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(404, { message: "not found" })));

    const client = createMercadoLivreClient({ fetchImpl, sleep: NOOP_SLEEP });

    await expect(
      client.request({ method: "GET", path: "/orders/1", schema: orderSchema }),
    ).rejects.toMatchObject({ errorClass: "not_retryable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("nunca deixa o access_token vazar na URL, na mensagem nem no corpo do erro", async () => {
    const segredo = "APP_USR-TOKEN-QUE-NAO-PODE-VAZAR";
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(401, { message: "invalid token" })));

    const client = createMercadoLivreClient({ fetchImpl, sleep: NOOP_SLEEP });

    try {
      await client.request({
        method: "GET",
        path: "/orders/1",
        accessToken: segredo,
        schema: orderSchema,
      });
      expect.unreachable("deveria ter lançado MercadoLivreApiError");
    } catch (error) {
      const serializado = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(serializado).not.toContain(segredo);
    }
  });

  it("envia POST com Content-Type json e corpo serializado", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["content-type"]).toBe("application/json");
      expect(init?.body).toBe(JSON.stringify({ note: "teste" }));
      return Promise.resolve(jsonResponse(200, { id: 1, status: "paid" }));
    });

    const client = createMercadoLivreClient({ fetchImpl });
    await client.request({
      method: "POST",
      path: "/orders/1/notes",
      body: { note: "teste" },
      schema: orderSchema,
    });
  });
});
