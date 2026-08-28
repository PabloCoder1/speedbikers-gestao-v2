import { describe, expect, it } from "vitest";

import {
  describeOutcome,
  MAX_SELECAO,
  normalizeSupplierBrand,
  parseSelecao,
  parseVirtualDecision,
  summarizeCuration,
} from "./sku-curation";

describe("normalizeSupplierBrand", () => {
  it("normaliza como a RPC: caixa alta, sem espaço nas bordas", () => {
    expect(normalizeSupplierBrand("  off racer ")).toEqual({ ok: true, value: "OFF RACER" });
  });

  it("colapsa espaço interno — 'OFF  RACER' e 'OFF RACER' são a MESMA marca", () => {
    // O `btrim` do SQL não faz isso. Sem colapsar aqui, duas grafias do mesmo
    // fornecedor conviveriam — exatamente o que D-129 teve de consertar com
    // uma migration de normalização depois.
    expect(normalizeSupplierBrand("OFF   RACER")).toEqual({ ok: true, value: "OFF RACER" });
  });

  it("vazio é VALOR (limpar), não erro — é a única forma de desfazer", () => {
    expect(normalizeSupplierBrand("")).toEqual({ ok: true, value: null });
    expect(normalizeSupplierBrand("     ")).toEqual({ ok: true, value: null });
  });

  it("recusa acima de 60 caracteres, espelhando o CHECK do banco", () => {
    const resultado = normalizeSupplierBrand("A".repeat(61));

    expect(resultado.ok).toBe(false);
  });

  it("aceita exatamente 60", () => {
    expect(normalizeSupplierBrand("A".repeat(60))).toEqual({ ok: true, value: "A".repeat(60) });
  });

  it("as 1.280 marcas já existentes não mudam com esta normalização", () => {
    // Medido no banco antes de escrever a migration: maior tem 12 caracteres,
    // nenhuma fora de caixa alta, nenhuma com espaço nas bordas. Se esta
    // função alterasse alguma, ela criaria marca gêmea no primeiro uso.
    for (const marca of ["OFF RACER", "NAVETEC", "PLASMOTO", "RT", "TMAC", "AOLIXIM", "PANDÃO", "R1 MOTOPARTS"]) {
      expect(normalizeSupplierBrand(marca)).toEqual({ ok: true, value: marca });
    }
  });
});

describe("parseVirtualDecision", () => {
  it("aceita as três decisões", () => {
    expect(parseVirtualDecision("VIRTUAL")).toEqual({ ok: true, value: "VIRTUAL" });
    expect(parseVirtualDecision("FISICO")).toEqual({ ok: true, value: "FISICO" });
    expect(parseVirtualDecision("INDEFINIDO")).toEqual({ ok: true, value: "INDEFINIDO" });
  });

  it("recusa qualquer outra coisa, inclusive booleano disfarçado", () => {
    for (const cru of ["", "true", "virtual", "SIM", "NULL"]) {
      expect(parseVirtualDecision(cru).ok).toBe(false);
    }
  });
});

describe("parseSelecao", () => {
  it("deduplica e descarta vazio", () => {
    expect(parseSelecao(["a", "a", "", "b"])).toEqual({ ok: true, value: ["a", "b"] });
  });

  it("recusa seleção vazia", () => {
    expect(parseSelecao([]).ok).toBe(false);
    expect(parseSelecao(["", ""]).ok).toBe(false);
  });

  it("recusa acima do teto, dizendo quantos foram selecionados", () => {
    const ids = Array.from({ length: MAX_SELECAO + 1 }, (_, i) => `sku-${String(i)}`);
    const resultado = parseSelecao(ids);

    expect(resultado.ok).toBe(false);
    expect(resultado.ok ? "" : resultado.message).toContain("501");
  });

  it("aceita exatamente o teto", () => {
    const ids = Array.from({ length: MAX_SELECAO }, (_, i) => `sku-${String(i)}`);

    expect(parseSelecao(ids).ok).toBe(true);
  });
});

describe("summarizeCuration", () => {
  it("separa aplicado, no-op e sumido — e só o APLICADO volta no Desfazer", () => {
    const outcome = summarizeCuration([
      { sku_id: "a", status: "APLICADO" },
      { sku_id: "b", status: "JA_DECIDIDO" },
      { sku_id: "c", status: "NAO_ENCONTRADO" },
      { sku_id: "d", status: "APLICADO" },
    ]);

    expect(outcome).toEqual({ applied: 2, unchanged: 1, notFound: 1, changedIds: ["a", "d"] });
  });

  it("desfazer NUNCA manda de volta o que já estava assim", () => {
    // Se o Desfazer mandasse os ids ENVIADOS em vez dos APLICADOS, ele
    // reverteria decisões que outra pessoa já tinha tomado antes.
    const outcome = summarizeCuration([
      { sku_id: "a", status: "JA_DECIDIDO" },
      { sku_id: "b", status: "JA_DECIDIDO" },
    ]);

    expect(outcome.changedIds).toEqual([]);
  });
});

describe("describeOutcome", () => {
  it("some com o que é zero, mas nunca esconde no-op nem sumido", () => {
    expect(describeOutcome({ applied: 412, unchanged: 0, notFound: 0, changedIds: [] })).toBe("412 aplicado(s)");
    expect(describeOutcome({ applied: 412, unchanged: 85, notFound: 3, changedIds: [] })).toBe(
      "412 aplicado(s) · 85 já estava(m) assim · 3 sumiu(ram) da lista — recarregue",
    );
  });

  it("zero aplicado continua sendo dito, não vira silêncio", () => {
    expect(describeOutcome({ applied: 0, unchanged: 100, notFound: 0, changedIds: [] })).toBe(
      "0 aplicado(s) · 100 já estava(m) assim",
    );
  });
});
