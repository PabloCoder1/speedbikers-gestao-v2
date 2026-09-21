import { describe, expect, it } from "vitest";

import { buildKnowledgeHref, resolveKnowledgeFilters } from "./knowledge-filters";

const LIMPOS = { status: null, kind: null, source: null, search: null, page: 1 } as const;

describe("resolveKnowledgeFilters", () => {
  it("accepts only closed values and trims search", () => {
    expect(resolveKnowledgeFilters({ status: "SUGERIDO", tipo: "COMPATIBILIDADE", fonte: "FABRICANTE", busca: "  XRE 300  " })).toEqual({ status: "SUGERIDO", kind: "COMPATIBILIDADE", source: "FABRICANTE", search: "XRE 300", page: 1 });
    expect(resolveKnowledgeFilters({ status: "DELETE", tipo: "qualquer", fonte: "DROP" })).toEqual(LIMPOS);
  });

  it("keeps invalid pages out of the database query", () => {
    expect(resolveKnowledgeFilters({ pagina: "0" }).page).toBe(1);
    expect(resolveKnowledgeFilters({ pagina: "2.9" }).page).toBe(2);
  });
});

describe("buildKnowledgeHref", () => {
  it("resets the page when the result set changes", () => {
    const current = { ...LIMPOS, status: "SUGERIDO" as const, page: 4 };
    expect(buildKnowledgeHref(current, { kind: "POLITICA" })).toBe("/atendimento/conhecimento?status=SUGERIDO&tipo=POLITICA");
    expect(buildKnowledgeHref(current, { page: 3 })).toBe("/atendimento/conhecimento?status=SUGERIDO&pagina=3");
  });
});
