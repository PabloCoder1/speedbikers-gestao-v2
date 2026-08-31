import { describe, expect, it } from "vitest";

import { buildMovementHref, resolveMovementFilters } from "./movement-filters.js";

describe("filtros de /estoque/movimentacoes (D-167)", () => {
  it("URL limpa: sem filtro nenhum, página 1", () => {
    expect(resolveMovementFilters({})).toEqual({
      search: null,
      movementType: null,
      locationKind: null,
      sourceType: null,
      dateFrom: null,
      dateTo: null,
      page: 1,
    });
  });

  it("valores FORA dos conjuntos fechados caem para 'sem filtro' — nunca chegam à RPC", () => {
    const filters = resolveMovementFilters({
      tipo: "TIPO_INVENTADO",
      local: "FULL",
      origem: "QUALQUER",
      de: "31/08/2026",
    });

    expect(filters.movementType).toBeNull();
    expect(filters.locationKind).toBeNull();
    expect(filters.sourceType).toBeNull();
    expect(filters.dateFrom).toBeNull();
  });

  it("valores válidos passam, com página", () => {
    const filters = resolveMovementFilters({
      tipo: "VENDA_ML",
      local: "LOCAL",
      origem: "ORDER",
      de: "2026-08-01",
      ate: "2026-08-31",
      busca: "5821",
      pagina: "3",
    });

    expect(filters).toMatchObject({
      movementType: "VENDA_ML",
      locationKind: "LOCAL",
      sourceType: "ORDER",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      search: "5821",
      page: 3,
    });
  });

  it("trocar uma dimensão preserva as outras e volta à página 1; trocar só a página a mantém", () => {
    const current = resolveMovementFilters({ tipo: "VENDA_ML", busca: "5821", pagina: "3" });

    const trocaTipo = buildMovementHref(current, { movementType: "AJUSTE_RECONCILIACAO" });
    expect(trocaTipo).toContain("tipo=AJUSTE_RECONCILIACAO");
    expect(trocaTipo).toContain("busca=5821");
    expect(trocaTipo).not.toContain("pagina=");

    const trocaPagina = buildMovementHref(current, { page: 4 });
    expect(trocaPagina).toContain("pagina=4");
    expect(trocaPagina).toContain("tipo=VENDA_ML");
  });
});
