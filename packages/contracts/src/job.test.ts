import { describe, expect, it } from "vitest";

import { jobEnvelopeSchema, toTaskName } from "./job.js";

const validEnvelope = {
  jobType: "analytics.recompute",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
  organizationId: "0b6d2f4a-1c3e-4a7b-8d5f-9e2c1a4b6d80",
  dedupeKey: "recompute:19c630d0-0bd7-4cda-a730-b58872bd42f2:2026-08-19:2026-08-21T15:37Z",
  attempt: 1,
  enqueuedAt: "2026-08-19T14:03:00.000Z",
};

describe("jobEnvelopeSchema", () => {
  it("aceita um envelope válido", () => {
    expect(jobEnvelopeSchema.parse(validEnvelope)).toEqual(validEnvelope);
  });

  it("rejeita tentativa menor que 1", () => {
    expect(() => jobEnvelopeSchema.parse({ ...validEnvelope, attempt: 0 })).toThrow();
  });

  it("rejeita organização que não é uuid", () => {
    expect(() =>
      jobEnvelopeSchema.parse({ ...validEnvelope, organizationId: "offracer" }),
    ).toThrow();
  });

  it("rejeita dedupeKey vazia", () => {
    expect(() => jobEnvelopeSchema.parse({ ...validEnvelope, dedupeKey: "" })).toThrow();
  });
});

describe("toTaskName", () => {
  it("é determinístico: a mesma chave sempre produz o mesmo nome", () => {
    const key = "recompute:19c630d0-0bd7-4cda-a730-b58872bd42f2:2026-08-19:2026-08-21T15:37Z";

    expect(toTaskName(key)).toBe(toTaskName(key));
  });

  it("troca caracteres inseguros por hífen", () => {
    expect(
      toTaskName("recompute:19c630d0-0bd7-4cda-a730-b58872bd42f2:2026-08-19:2026-08-21T15:37Z"),
    ).toBe(
      "recompute-19c630d0-0bd7-4cda-a730-b58872bd42f2-2026-08-19-2026-08-21T15-37Z",
    );
  });

  it("não deixa hífen nas bordas", () => {
    expect(toTaskName(":::sync:::")).toBe("sync");
  });

  it("mantém chaves distintas distintas", () => {
    expect(
      toTaskName("recompute:19c630d0-0bd7-4cda-a730-b58872bd42f2:2026-08-19:2026-08-21T15:37Z"),
    ).not.toBe(
      toTaskName("recompute:0e58f3e2-d6f2-4d4e-8b7f-a5c3c8441598:2026-08-19:2026-08-21T15:37Z"),
    );
  });

  it("trunca chave longa mantendo unicidade", () => {
    const base = "recompute:offracer:".padEnd(400, "X");
    const other = `${base}Y`;

    const name = toTaskName(base);

    expect(name.length).toBeLessThanOrEqual(200);
    expect(name).not.toBe(toTaskName(other));
  });

  it("nunca devolve nome vazio", () => {
    expect(toTaskName(":::")).not.toBe("");
  });
});
