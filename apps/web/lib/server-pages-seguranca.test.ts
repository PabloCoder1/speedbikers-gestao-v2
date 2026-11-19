import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { escaparIlike, resolverContaSolicitada } from "./postgrest-search";

function lerPagina(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("D-783 — Server Components falham fechado em erro de contas/organização, escapam ILIKE e limitam .in()", () => {
  it("resolverContaSolicitada falha fechado quando uma conta foi pedida e a leitura falhou", () => {
    const contas = [{ id: "id-1", slug: "loja-1" }];

    expect(resolverContaSolicitada(null, null)).toEqual({ conta: null, erro: null });
    expect(resolverContaSolicitada("id-1", { data: contas, error: null })).toEqual({
      conta: contas[0],
      erro: null,
    });
    expect(
      resolverContaSolicitada("loja-1", { data: contas, error: null }, (c, slug) => c.slug === slug),
    ).toEqual({
      conta: contas[0],
      erro: null,
    });
    expect(resolverContaSolicitada("desconhecida", { data: contas, error: null })).toEqual({
      conta: null,
      erro: null,
    });
    expect(resolverContaSolicitada("id-1", { data: null, error: { message: "db timeout" } })).toEqual({
      conta: null,
      erro: { message: "db timeout" },
    });
    expect(resolverContaSolicitada("id-1", null)).toEqual({
      conta: null,
      erro: { message: "falha ao ler contas" },
    });
  });

  it("/precos e /full usam resolverContaSolicitada, pulam RPC quando erroConta != null e separam erro de membership", () => {
    for (const rel of ["app/(app)/precos/page.tsx", "app/(app)/full/page.tsx"]) {
      const codigo = lerPagina(rel);
      expect(codigo, rel).toContain("resolverContaSolicitada");
      expect(codigo, rel).toContain("erroConta !== null");
      expect(codigo, rel).toContain("membershipError !== null");
      expect(codigo, rel).toContain('tipo="erro"');
    }
  });

  it("/atendimento/perguntas usa resolverContaSolicitada e pula consultas quando erroConta != null", () => {
    const codigo = lerPagina("app/(app)/atendimento/perguntas/page.tsx");

    expect(codigo).toContain("resolverContaSolicitada");
    expect(codigo).toContain("erroConta !== null");
  });

  it("/atendimento/conhecimento escapa ILIKE com escaparIlike e expõe membership.error", () => {
    const codigo = lerPagina("app/(app)/atendimento/conhecimento/page.tsx");

    expect(codigo).toContain("escaparIlike(filters.search)");
    expect(codigo).toContain("membership.error");
    expect(escaparIlike("100%_A\\B")).toBe("100\\%\\_A\\\\B");
  });

  it("/atendimento limita SEARCH_LIMIT a no máximo 100 UUIDs e trunca ids antes do .in()", () => {
    const codigo = lerPagina("app/(app)/atendimento/page.tsx");
    const match = /const SEARCH_LIMIT = (\d+);/.exec(codigo);

    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeLessThanOrEqual(100);
    expect(codigo).toContain(".slice(0, SEARCH_LIMIT)");
  });
});
