import { describe, expect, it } from "vitest";

import { lerSugestoes, marcaDoFornecedor } from "./sugestoes";

const linha = {
  sku_id: "7b9b3a2e-0d9c-4f3a-9d0e-1c2b3a4d5e6f",
  sku: "GV-001",
  title: "Baú Givi 33L",
  supplier_brand: "GIVI",
  purchase_cost: 199.9,
  is_imported: true,
  state: "RUPTURA",
  suggested_quantity: 12,
  coverage_days: 0,
  units_30d: 18,
  aproveitavel: -2,
};

describe("lerSugestoes", () => {
  it("lê a resposta e converte para o vocabulário da tela", () => {
    const r = lerSugestoes({ total: 1, linhas: [linha] });

    expect(r?.linhas[0]).toMatchObject({ skuId: linha.sku_id, suggestedQuantity: 12, state: "RUPTURA", aproveitavel: -2 });
  });

  it("recusa, estoque virtual e sem custo continuam nulos — nunca viram zero", () => {
    const r = lerSugestoes({
      total: 1,
      linhas: [{ ...linha, state: null, suggested_quantity: null, aproveitavel: null, purchase_cost: null, is_imported: null }],
    });

    expect(r?.linhas[0]).toMatchObject({ state: null, suggestedQuantity: null, aproveitavel: null, purchaseCost: null });
  });

  it("campo renomeado ou tipo trocado recusa a resposta inteira", () => {
    const semCampo: Record<string, unknown> = { ...linha };
    delete semCampo.suggested_quantity;

    expect(lerSugestoes({ total: 1, linhas: [semCampo] })).toBeNull();
    expect(lerSugestoes({ total: 1, linhas: [{ ...linha, units_30d: "18" }] })).toBeNull();
    expect(lerSugestoes({ linhas: [] })).toBeNull();
    expect(lerSugestoes(null)).toBeNull();
  });
});

describe("marcaDoFornecedor", () => {
  const marcas = ["GIVI", "PRO TORK", "Pro", "Shad", "X11"];

  it("nome igual ou marca como palavra inteira do nome", () => {
    expect(marcaDoFornecedor("Givi", marcas)).toBe("GIVI");
    expect(marcaDoFornecedor("Givi Brasil Ltda", marcas)).toBe("GIVI");
    expect(marcaDoFornecedor("SHAD — Distribuidora", marcas)).toBe("Shad");
  });

  it("mais de uma candidata: fica a mais específica", () => {
    expect(marcaDoFornecedor("Pro Tork Motos", marcas)).toBe("PRO TORK");
  });

  it("pedaço de palavra não é marca, e nada bate é nulo", () => {
    expect(marcaDoFornecedor("Navetec", marcas)).toBeNull();
    expect(marcaDoFornecedor("Protec Peças", marcas)).toBeNull();
    expect(marcaDoFornecedor(null, marcas)).toBeNull();
    expect(marcaDoFornecedor("   ", marcas)).toBeNull();
  });

  it("acento e caixa não atrapalham", () => {
    expect(marcaDoFornecedor("Peças Açaí", ["ACAI", "PECAS ACAI"])).toBe("PECAS ACAI");
  });
});
