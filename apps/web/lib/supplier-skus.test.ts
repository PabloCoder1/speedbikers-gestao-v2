import { describe, expect, it } from "vitest";

import { lerProdutosFornecidos } from "./supplier-skus";

const linha = {
  id: "p1",
  sku_id: "s1",
  sku: "SB-1",
  title: "Pneu",
  supplier_code: "FX-1",
  description: null,
  unit_cost: 18,
  currency: "BRL",
  cadastro_cost: 20,
  minimum_order_quantity: 20,
  pack_multiple: 12,
  lead_time_days: 30,
  is_preferred: true,
  notes: null,
  is_discontinued: false,
  unidades_compradas: null,
  pedidos: 0,
  ultima_compra: null,
};

describe("lerProdutosFornecidos (D-723)", () => {
  it("lê o contrato; sem compra ainda, unidades nulas (não zero)", () => {
    const r = lerProdutosFornecidos({ total: 1, linhas: [linha] });

    expect(r?.linhas[0]).toMatchObject({ sku: "SB-1", minimumOrderQuantity: 20, packMultiple: 12, unidadesCompradas: null });
  });

  it("recusa a resposta inteira fora do contrato", () => {
    expect(lerProdutosFornecidos({ total: 1, linhas: [{ ...linha, pack_multiple: "12" }] })).toBeNull();
    expect(lerProdutosFornecidos({ linhas: [] })).toBeNull();
  });
});
