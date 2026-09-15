import { describe, expect, it } from "vitest";

import { POST } from "./route";

describe("POST /api/vitals", () => {
  it("accepts a metric with a route and returns 202", async () => {
    const response = await POST(new Request("http://localhost/api/vitals", {
      method: "POST",
      body: JSON.stringify({ name: "LCP", value: 123.45, path: "/vendas" }),
      headers: { "content-type": "application/json" },
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it.each([
    { name: "UNKNOWN", value: 1, path: "/" },
    { name: "CLS", value: Number.NaN, path: "/" },
    { name: "INP", value: 1, path: "vendas" },
  ])("rejects invalid payload %#", async (payload) => {
    const response = await POST(new Request("http://localhost/api/vitals", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    }));

    expect(response.status).toBe(400);
  });
});
