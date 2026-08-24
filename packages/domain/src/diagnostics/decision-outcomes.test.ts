import { describe, expect, it } from "vitest";

import { computePendingOutcomeWindows } from "./decision-outcomes.js";

const DECIDED_AT = new Date("2026-08-01T10:00:00.000Z");

describe("computePendingOutcomeWindows", () => {
  it("decisão recém-tomada: nenhuma janela pendente ainda", () => {
    const now = new Date("2026-08-02T10:00:00.000Z");

    expect(computePendingOutcomeWindows(DECIDED_AT, now, [])).toEqual([]);
  });

  it("exatos 7 dias depois: janela de 7 fica pendente, 15 e 30 ainda não", () => {
    const now = new Date("2026-08-08T10:00:00.000Z");

    expect(computePendingOutcomeWindows(DECIDED_AT, now, [])).toEqual([7]);
  });

  it("15 dias depois: janelas de 7 e 15 pendentes, 30 ainda não", () => {
    const now = new Date("2026-08-16T10:00:00.000Z");

    expect(computePendingOutcomeWindows(DECIDED_AT, now, [])).toEqual([7, 15]);
  });

  it("30+ dias depois: as três janelas pendentes", () => {
    const now = new Date("2026-09-05T10:00:00.000Z");

    expect(computePendingOutcomeWindows(DECIDED_AT, now, [])).toEqual([7, 15, 30]);
  });

  it("janela já medida não volta a ficar pendente", () => {
    const now = new Date("2026-09-05T10:00:00.000Z");

    expect(computePendingOutcomeWindows(DECIDED_AT, now, [7, 15])).toEqual([30]);
  });

  it("todas as janelas já medidas: nada pendente", () => {
    const now = new Date("2026-09-05T10:00:00.000Z");

    expect(computePendingOutcomeWindows(DECIDED_AT, now, [7, 15, 30])).toEqual([]);
  });

  it("um dia antes de completar 7 dias: ainda não pendente (idade em dias corridos, não arredondada pra cima)", () => {
    const now = new Date("2026-08-07T09:00:00.000Z");

    expect(computePendingOutcomeWindows(DECIDED_AT, now, [])).toEqual([]);
  });
});
