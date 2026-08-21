import { describe, expect, it } from "vitest";

import { classifyStatus, computeBackoffDelayMs, parseRetryAfterMs } from "./retry.js";

describe("classifyStatus", () => {
  it.each([429, 500, 502, 503])("classifica %i como retryable", (status) => {
    expect(classifyStatus(status)).toBe("retryable");
  });

  it.each([400, 401, 403, 422])("classifica %i como not_retryable", (status) => {
    expect(classifyStatus(status)).toBe("not_retryable");
  });

  it("classifica 404 como not_retryable quando o chamador não sinaliza tolerância", () => {
    expect(classifyStatus(404)).toBe("not_retryable");
  });

  it("classifica 404 como retryable_eventual quando o chamador sinaliza tolerância", () => {
    expect(classifyStatus(404, { eventualConsistencyTolerant: true })).toBe("retryable_eventual");
  });
});

describe("computeBackoffDelayMs", () => {
  it("cresce exponencialmente com a tentativa, limitado pelo teto máximo", () => {
    const semJitter = (): number => 1; // full jitter no teto = sem aleatoriedade

    expect(
      computeBackoffDelayMs({ attempt: 1, baseDelayMs: 500, maxDelayMs: 30_000, random: semJitter }),
    ).toBe(500);
    expect(
      computeBackoffDelayMs({ attempt: 2, baseDelayMs: 500, maxDelayMs: 30_000, random: semJitter }),
    ).toBe(1_000);
    expect(
      computeBackoffDelayMs({ attempt: 10, baseDelayMs: 500, maxDelayMs: 30_000, random: semJitter }),
    ).toBe(30_000);
  });

  it("nunca fica abaixo de zero nem acima do teto exponencial (full jitter)", () => {
    const random = (): number => 0;

    expect(computeBackoffDelayMs({ attempt: 3, baseDelayMs: 500, random })).toBe(0);
  });

  it("respeita Retry-After quando ele pede mais tempo que o jitter calculado", () => {
    const semJitter = (): number => 0;

    expect(
      computeBackoffDelayMs({ attempt: 1, baseDelayMs: 500, retryAfterMs: 5_000, random: semJitter }),
    ).toBe(5_000);
  });

  it("usa o jitter calculado quando ele é maior que o Retry-After", () => {
    const jitterAlto = (): number => 1;

    expect(
      computeBackoffDelayMs({
        attempt: 3,
        baseDelayMs: 500,
        retryAfterMs: 100,
        random: jitterAlto,
      }),
    ).toBe(2_000);
  });
});

describe("parseRetryAfterMs", () => {
  it("interpreta segundos", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
  });

  it("interpreta zero segundos", () => {
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("interpreta uma data HTTP no futuro", () => {
    const agora = (): Date => new Date("2026-08-21T10:00:00.000Z");

    expect(parseRetryAfterMs("Fri, 21 Aug 2026 10:00:30 GMT", agora)).toBe(30_000);
  });

  it("data HTTP no passado vira zero, não negativo", () => {
    const agora = (): Date => new Date("2026-08-21T10:00:00.000Z");

    expect(parseRetryAfterMs("Fri, 21 Aug 2026 09:00:00 GMT", agora)).toBe(0);
  });

  it("devolve undefined quando o header está ausente", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it("devolve undefined quando o header é malformado", () => {
    expect(parseRetryAfterMs("nao-e-nem-numero-nem-data")).toBeUndefined();
  });
});
