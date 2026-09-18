import { describe, expect, it } from "vitest";

import { lastBusinessDays } from "./business-window";

describe("lastBusinessDays", () => {
  it("usa o dia de São Paulo, não o de UTC: 22h de Brasília ainda é o mesmo dia", () => {
    // 2026-09-19T01:00Z = 18/09 às 22h em São Paulo.
    expect(lastBusinessDays(30, new Date("2026-09-19T01:00:00Z"))).toEqual({ from: "2026-08-20", to: "2026-09-18" });
  });

  it("inclui hoje nas duas pontas: 1 dia é só hoje", () => {
    expect(lastBusinessDays(1, new Date("2026-09-18T15:00:00Z"))).toEqual({ from: "2026-09-18", to: "2026-09-18" });
  });

  it("atravessa a virada do mês", () => {
    expect(lastBusinessDays(7, new Date("2026-10-02T15:00:00Z"))).toEqual({ from: "2026-09-26", to: "2026-10-02" });
  });
});
