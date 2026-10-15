import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

function post(payload: unknown): Promise<Response> {
  return POST(new Request("http://localhost/api/vitals", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  }));
}

describe("POST /api/vitals", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("accepts a metric with a route and returns 202", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await post({ name: "LCP", value: 123.45, path: "/vendas", softNav: false });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("logs the soft navigation signal with the loaded route", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await post({ name: "CLS", value: 0.12, path: "/", softNav: true });

    expect(info.mock.calls[0]).toStrictEqual(["web_vital", { name: "CLS", value: 0.12, path: "/", softNav: true }]);
  });

  it("keeps the old reporter's lines, without the field, so the cut stays visible in the log", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await post({ name: "LCP", value: 3500, path: "/vendas" });

    expect(response.status).toBe(202);
    expect(info.mock.calls[0]).toStrictEqual(["web_vital", { name: "LCP", value: 3500, path: "/vendas" }]);
  });

  it("cuts the route at 120 characters", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await post({ name: "TTFB", value: 80, path: `/${"a".repeat(200)}`, softNav: false });

    expect(info.mock.calls[0]?.[1]).toMatchObject({ path: `/${"a".repeat(119)}` });
  });

  it.each([
    { name: "UNKNOWN", value: 1, path: "/" },
    { name: "CLS", value: Number.NaN, path: "/" },
    { name: "INP", value: 1, path: "vendas" },
    { name: "LCP", value: 1, path: "/", softNav: "yes" },
    { name: "LCP", value: 1, path: "/", softNav: null },
  ])("rejects invalid payload %#", async (payload) => {
    const response = await post(payload);

    expect(response.status).toBe(400);
  });
});
