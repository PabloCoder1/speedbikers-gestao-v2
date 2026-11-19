import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { escaparIlike, resolverContaSolicitada, resolverContasSolicitadas } from "./postgrest-search";

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

describe("D-784 — Demais Server Components falham fechado em contas/organização e BuscaSku trata falha de transporte", () => {
  it("resolverContasSolicitadas falha fechado quando ?contas= foi pedido e marketplace_accounts falhou", () => {
    const lista = [{ account_id: "a1", marketplace: "SHOPEE" as const, name: "Loja 1", environment: "live" as const }];

    expect(resolverContasSolicitadas(undefined, null, () => ({ selecionadas: lista, descartadas: 0 }))).toEqual({
      resultado: null,
      erro: null,
    });
    expect(resolverContasSolicitadas("   ", null, () => ({ selecionadas: lista, descartadas: 0 }))).toEqual({
      resultado: null,
      erro: null,
    });
    expect(
      resolverContasSolicitadas("a1", { data: null, error: { message: "timeout" } }, () => ({
        selecionadas: lista,
        descartadas: 0,
      })),
    ).toEqual({
      resultado: null,
      erro: { message: "timeout" },
    });
    expect(
      resolverContasSolicitadas("a1", { data: lista, error: null }, (raw, contas) => ({
        selecionadas: contas.filter((c) => c.account_id === raw),
        descartadas: 0,
      })),
    ).toEqual({
      resultado: { selecionadas: lista, descartadas: 0 },
      erro: null,
    });
  });

  it("/anuncios, /vinculacoes e /curva-abc falham fechado em erro de contas solicitadas e separam erro de membership", () => {
    for (const rel of [
      "app/(app)/anuncios/page.tsx",
      "app/(app)/vinculacoes/page.tsx",
      "app/(app)/curva-abc/page.tsx",
    ]) {
      const codigo = lerPagina(rel);
      expect(codigo, rel).toContain("resolverContaSolicitada");
      expect(codigo, rel).toContain("erroConta !== null");
      expect(codigo, rel).toContain("membershipError !== null");
      expect(codigo, rel).toContain('tipo="erro"');
    }
    expect(lerPagina("app/(app)/curva-abc/page.tsx")).toContain("resolverContasSolicitadas");
  });

  it("/faturamento, /vendas e /central falham fechado quando ?account= ou ?contas= é pedido e a leitura de contas falha", () => {
    for (const rel of [
      "app/(app)/faturamento/page.tsx",
      "app/(app)/vendas/page.tsx",
      "app/(app)/central/page.tsx",
      "app/(app)/central/produtos/page.tsx",
    ]) {
      const codigo = lerPagina(rel);
      expect(codigo, rel).toContain("resolverContaSolicitada");
      expect(codigo, rel).toContain("erroConta !== null");
    }

    for (const rel of ["app/(app)/faturamento/multicanal.tsx", "app/(app)/vendas/multicanal.tsx"]) {
      const codigo = lerPagina(rel);
      expect(codigo, rel).toContain("resolverContasSolicitadas");
      expect(codigo, rel).toContain("erroContas !== null");
      expect(codigo, rel).toContain("membershipError !== null");
    }
  });

  it("/anuncios/shopee e /vendas/shopee separam membership.error de falta de organização", () => {
    for (const rel of ["app/(app)/anuncios/shopee/page.tsx", "app/(app)/vendas/shopee/page.tsx"]) {
      const codigo = lerPagina(rel);
      expect(codigo, rel).toContain("membership.error !== null");
      expect(codigo, rel).toContain("Não foi possível confirmar sua organização.");
    }
  });

  it("BuscaSku protege busca contra rejeição de transporte sem travar buscando=true", () => {
    const codigo = lerPagina("app/(app)/vinculacoes/busca-sku.tsx");

    expect(codigo).toMatch(/try\s*\{[\s\S]*from\("skus"\)[\s\S]*\}\s*catch[\s\S]*\}\s*finally/);
  });
});
