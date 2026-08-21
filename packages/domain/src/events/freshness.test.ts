import { describe, expect, it } from "vitest";

import { classifySyncFreshness } from "./freshness.js";

const NOW = new Date("2026-08-21T15:00:00.000Z");

describe("classifySyncFreshness", () => {
  it("nunca_sincronizado quando latestRecordAt é nulo", () => {
    expect(classifySyncFreshness(null, NOW)).toBe("nunca_sincronizado");
  });

  it("ok até 3 horas de idade", () => {
    expect(classifySyncFreshness(new Date("2026-08-21T14:00:00.000Z"), NOW)).toBe("ok");
    expect(classifySyncFreshness(new Date("2026-08-21T12:00:00.001Z"), NOW)).toBe("ok");
  });

  it("atencao entre 3 e 12 horas de idade", () => {
    expect(classifySyncFreshness(new Date("2026-08-21T11:59:59.000Z"), NOW)).toBe("atencao");
    expect(classifySyncFreshness(new Date("2026-08-21T03:00:00.001Z"), NOW)).toBe("atencao");
  });

  it("critico acima de 12 horas de idade", () => {
    expect(classifySyncFreshness(new Date("2026-08-21T02:59:59.000Z"), NOW)).toBe("critico");
    expect(classifySyncFreshness(new Date("2026-08-01T00:00:00.000Z"), NOW)).toBe("critico");
  });

  it("registro no futuro (relógio adiantado) ainda conta como ok, nunca negativo", () => {
    expect(classifySyncFreshness(new Date("2026-08-21T16:00:00.000Z"), NOW)).toBe("ok");
  });
});
