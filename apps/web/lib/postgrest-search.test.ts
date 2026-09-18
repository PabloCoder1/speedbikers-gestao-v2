import { describe, expect, it } from "vitest";

import { termoSeguroParaOr } from "./postgrest-search";

describe("termoSeguroParaOr", () => {
  it("tira o que quebra o or= do PostgREST ou muda o padrão do ilike", () => {
    expect(termoSeguroParaOr("pastilha (dianteira), 100%")).toBe("pastilha  dianteira   100");
    expect(termoSeguroParaOr("  Kit*relação  ")).toBe("Kit relação");
  });

  it("texto limpo passa igual", () => {
    expect(termoSeguroParaOr("E2E-SKU-001")).toBe("E2E-SKU-001");
  });
});
