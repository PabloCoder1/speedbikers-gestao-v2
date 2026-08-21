import { describe, expect, it } from "vitest";

import {
  businessDateRangeLength,
  previousBusinessDateRange,
  shiftBusinessDate,
  toSalesMetricDate,
} from "./business-date.js";

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

describe("businessDateRangeLength", () => {
  it.each([
    ["2026-08-01", "2026-08-30", 30],
    ["2026-08-21", "2026-08-21", 1],
    ["2026-01-01", "2026-12-31", 365],
    ["2024-01-01", "2024-12-31", 366],
  ])("de %s a %s são %i dias", (from, to, expected) => {
    expect(businessDateRangeLength(from, to)).toBe(expected);
  });

  it("recusa data final anterior à inicial", () => {
    expect(() => businessDateRangeLength("2026-08-21", "2026-08-20")).toThrow(
      /data final anterior à data inicial/,
    );
  });
});

describe("previousBusinessDateRange", () => {
  it("janela anterior tem o mesmo tamanho e não sobrepõe", () => {
    expect(previousBusinessDateRange("2026-07-23", "2026-08-21")).toEqual({
      from: "2026-06-23",
      to: "2026-07-22",
    });
  });

  it("funciona para um único dia", () => {
    expect(previousBusinessDateRange("2026-08-21", "2026-08-21")).toEqual({
      from: "2026-08-20",
      to: "2026-08-20",
    });
  });

  it("atravessa virada de ano", () => {
    expect(previousBusinessDateRange("2026-01-01", "2026-01-07")).toEqual({
      from: "2025-12-25",
      to: "2025-12-31",
    });
  });
});
