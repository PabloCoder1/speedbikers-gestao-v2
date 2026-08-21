import { describe, expect, it } from "vitest";

import { shiftBusinessDate, toSalesMetricDate } from "./business-date.js";

describe("toSalesMetricDate", () => {
  it.each([
    ["2026-08-20T02:59:59.999Z", "2026-08-19"],
    ["2026-08-20T03:00:00.000Z", "2026-08-20"],
    ["2026-08-21T01:30:00.000Z", "2026-08-20"],
    ["2018-02-18T01:59:59.999Z", "2018-02-17"],
    ["2018-02-18T02:00:00.000Z", "2018-02-17"],
  ])("%s pertence ao dia de negócio %s", (instant, expected) => {
    expect(toSalesMetricDate(instant)).toBe(expected);
  });

  it("aceita Date sem mutá-la", () => {
    const instant = new Date("2026-08-21T01:30:00.000Z");

    expect(toSalesMetricDate(instant)).toBe("2026-08-20");
    expect(instant.toISOString()).toBe("2026-08-21T01:30:00.000Z");
  });

  it("recusa instante inválido", () => {
    expect(() => toSalesMetricDate("não-é-data")).toThrow(/instante inválido/);
  });
});

describe("shiftBusinessDate", () => {
  it.each([
    ["2026-08-21", -29, "2026-07-23"],
    ["2026-08-21", 0, "2026-08-21"],
    ["2026-03-01", -1, "2026-02-28"],
    ["2024-03-01", -1, "2024-02-29"],
    ["2026-01-01", -1, "2025-12-31"],
    ["2025-12-31", 1, "2026-01-01"],
  ])("%s deslocado em %i dias vira %s", (date, days, expected) => {
    expect(shiftBusinessDate(date, days)).toBe(expected);
  });

  it("recusa formato inválido", () => {
    expect(() => shiftBusinessDate("21/08/2026", -1)).toThrow(/data de negócio inválida/);
  });
});
