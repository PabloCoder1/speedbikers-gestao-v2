import { describe, expect, it } from "vitest";

import { formatLatency } from "./format";

/**
 * A duração curta (D-309), e o caso que a revisão adversarial pegou antes de
 * ele chegar à tela.
 */
describe("formatLatency", () => {
  it("milissegundo cru abaixo de mil, SEM agrupamento de milhar", () => {
    expect(formatLatency(42)).toBe("42 ms");
    expect(formatLatency(186)).toBe("186 ms");
    expect(formatLatency(999)).toBe("999 ms");
  });

  /*
    O DEFEITO QUE ISTO IMPEDE: `formatCount(3842)` devolve "3.842" em pt-BR, e
    "3.842 ms" se lê como três milissegundos e pouco. O tempo mais lento que a
    medição consegue produzir (o timeout é 4 s) seria o que pareceria mais
    rápido na tela.
  */
  it("de mil para cima vira segundo, e aí ninguém confunde com rápido", () => {
    expect(formatLatency(1000)).toBe("1,0 s");
    expect(formatLatency(3842)).toBe("3,8 s");
    expect(formatLatency(3999)).toBe("4,0 s");
  });

  it("sem medição é traço, nunca zero", () => {
    expect(formatLatency(null)).toBe("—");
  });
});
