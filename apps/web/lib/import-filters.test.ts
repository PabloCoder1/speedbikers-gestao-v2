import { describe, expect, it } from "vitest";

import {
  buildImportHref,
  buildRowHref,
  resolveImportFilters,
  resolveRowFilters,
  summarizeBatchWindow,
  summarizeRowWindow,
} from "./import-filters.js";

describe("filtros de /importacoes (D-278)", () => {
  it("URL limpa: sem filtro nenhum, página 1", () => {
    expect(resolveImportFilters({})).toEqual({ kind: null, status: null, page: 1 });
  });

  it("valor FORA do conjunto fechado do banco cai para 'sem filtro'", () => {
    // `erp_import_batches_kind_check` e `_status_check` são a fonte: valor
    // inventado na URL não pode virar consulta (zero linhas seria
    // indistinguível de filtro legítimo sem resultado).
    const filtros = resolveImportFilters({ tipo: "PLANILHAS", estado: "PRONTO" });

    expect(filtros.kind).toBeNull();
    expect(filtros.status).toBeNull();
  });

  it("valores válidos passam, com página", () => {
    expect(resolveImportFilters({ tipo: "LINKS", estado: "APPLIED", pagina: "2" })).toEqual({
      kind: "LINKS",
      status: "APPLIED",
      page: 2,
    });
  });

  it("trocar de recorte volta para a página 1; paginar preserva o recorte", () => {
    expect(buildImportHref({ kind: null, status: null, page: 4 }, { kind: "STOCK" })).toBe(
      "/importacoes?tipo=STOCK",
    );
    expect(buildImportHref({ kind: "STOCK", status: "APPLIED", page: 1 }, { page: 3 })).toBe(
      "/importacoes?tipo=STOCK&estado=APPLIED&pagina=3",
    );
  });

  it("a janela declara o total — a lista lia 50 e não dizia que eram 50", () => {
    expect(summarizeBatchWindow(1, 4, 4).label).toBe("4 importações.");
    expect(summarizeBatchWindow(1, 120, 50).label).toContain("de 120 importações");
    expect(summarizeBatchWindow(1, 0, 0).label).toBe("Nenhuma importação com estes filtros.");
  });
});

describe("filtros da conferência de um lote (D-278)", () => {
  const lote = "11111111-2222-3333-4444-555555555555";

  it("status de linha fora do conjunto fechado vira 'todas'", () => {
    expect(resolveRowFilters({ status: "DUVIDOSA" })).toEqual({ status: null, page: 1 });
    expect(resolveRowFilters({ status: "INVALID", pagina: "7" })).toEqual({ status: "INVALID", page: 7 });
  });

  it("o href preserva o lote e zera a página ao trocar de filtro", () => {
    expect(buildRowHref(lote, { status: null, page: 9 }, { status: "SKIPPED" })).toBe(
      `/importacoes/${lote}?status=SKIPPED`,
    );
    expect(buildRowHref(lote, { status: "SKIPPED", page: 1 }, { page: 2 })).toBe(
      `/importacoes/${lote}?status=SKIPPED&pagina=2`,
    );
    expect(buildRowHref(lote, { status: null, page: 1 }, {})).toBe(`/importacoes/${lote}`);
  });

  it("a janela das linhas diz que a ordem é a da planilha", () => {
    expect(summarizeRowWindow(2, 23924, 100).label).toContain("na ordem da planilha");
    // Uma página só não recebe a faixa: "1 a 12 de 12" é ruído (D-141).
    expect(summarizeRowWindow(1, 12, 12).label).toBe("12 linhas.");
  });
});
