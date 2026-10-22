import { describe, expect, it } from "vitest";

import { anuncioExcluido, avisoDeVinculoDoExcluido, quandoAV3ViuAExclusao } from "./anuncio-excluido";

describe("anuncioExcluido", () => {
  it("é o deleted_at preenchido, e nada mais", () => {
    expect(anuncioExcluido("2026-10-21T18:00:00Z")).toBe(true);
    expect(anuncioExcluido(null)).toBe(false);
    // A coluna ausente (o select sem ela) não vira excluído.
    expect(anuncioExcluido(undefined)).toBe(false);
    expect(anuncioExcluido("")).toBe(false);
  });
});

describe("quandoAV3ViuAExclusao", () => {
  it("diz a data da leitura no fuso de São Paulo, nunca 'excluído em'", () => {
    // 01:30 UTC de 22/10 ainda é 21/10 em São Paulo.
    expect(quandoAV3ViuAExclusao("2026-10-22T01:30:00Z")).toBe("a V3 viu a exclusão em 21/10/2026");
  });
});

describe("avisoDeVinculoDoExcluido", () => {
  it("nomeia o anúncio, a leitura e o porquê", () => {
    const aviso = avisoDeVinculoDoExcluido("MLB123", "2026-10-21T15:00:00Z");

    expect(aviso).toContain("MLB123 foi excluído no Mercado Livre");
    expect(aviso).toContain("a V3 viu a exclusão em 21/10/2026");
    expect(aviso).toContain("Não vinculamos anúncio que não existe mais");
  });
});
