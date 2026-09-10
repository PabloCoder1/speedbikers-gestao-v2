import { describe, expect, it } from "vitest";

import { composeSkuReplenishment, type SkuReplenishmentRow } from "./sku-replenishment.js";
import type { ReplenishmentSetting } from "./replenishment-policy.js";

/**
 * A composição do veredito de reposição (D-293).
 *
 * As cinco peças já têm testes próprios; o que estes casos protegem é o
 * ARRANJO — porque agora ele tem dois consumidores (a tela e o Copiloto) e
 * **os dois precisam devolver o mesmo número**. Um assistente que contradiz a
 * tela aberta ao lado é a pior forma de errar que este produto tem.
 */

const PADRAO: ReplenishmentSetting = {
  supplierBrand: null,
  skuId: null,
  leadTimeDays: 10,
  targetCoverageDays: 30,
  safetyStockDays: 5,
  maxCoverageDays: null,
  policyNote: null,
};

const LINHA: SkuReplenishmentRow = {
  sku_id: "11111111-1111-4111-8111-111111111111",
  sku: "SB-001",
  title: "Pneu 29",
  supplier_brand: "VAZ",
  local_quantity: 30,
  full_quantity: 10,
  transito: 5,
  reservado: 4,
  stock_is_virtual: false,
  units_15d: 45,
  units_30d: 90,
  units_60d: 180,
  units_90d: 270,
  history_days_90: 90,
};

describe("composeSkuReplenishment", () => {
  it("compõe as cinco peças: aproveitável, tendência, política, sugestão e estado", () => {
    const v = composeSkuReplenishment(LINHA, [PADRAO]);

    // Aproveitável = local + Full + trânsito, com o reservado FORA (D-146).
    expect(v.usable.total).toBe(45);
    expect(v.usable.components.reservedExcluded).toBe(4);

    // 90 unidades em 30 dias = 3/dia; 45 ÷ 3 = 15 dias de cobertura.
    expect(v.stockState.coverageDays).toBe(15);

    // 15 dias está acima do prazo (10) e abaixo de prazo + segurança (15)?
    // Não: 15 <= 15, então é COMPRAR_EM_BREVE — o limiar é inclusivo, e é a
    // peça `classifyStockState` que manda, não esta composição.
    expect(v.stockState.state).toBe("COMPRAR_EM_BREVE");

    // A política veio do PADRÃO da organização, e o escopo diz isso.
    expect(v.policy?.scope).toBe("PADRAO");

    // Sugestão = 3/dia × (10 + 30 + 5) − 45 aproveitável.
    expect(v.suggestion.suggestedQuantity).toBe(90);
    expect(v.suggestion.refusals).toEqual([]);
  });

  /*
    A recusa que não pode virar zero: sem configuração aplicável não há janela
    de demanda, e portanto não há quantidade defensável (D-144). A COBERTURA,
    porém, continua saindo — ela não depende de política.
  */
  it("sem política aplicável, a sugestão RECUSA e a cobertura continua", () => {
    const v = composeSkuReplenishment(LINHA, []);

    expect(v.policy).toBeNull();
    expect(v.suggestion.suggestedQuantity).toBeNull();
    expect(v.suggestion.refusals).toContain("SEM_CONFIGURACAO");
    expect(v.stockState.coverageDays).toBe(15);
    expect(v.stockState.state).toBeNull();
  });

  /** Saldo sentinela não é contagem (D-127): aproveitável e cobertura somem juntos. */
  it("SKU virtual não recebe aproveitável nem cobertura", () => {
    const v = composeSkuReplenishment({ ...LINHA, stock_is_virtual: true }, [PADRAO]);

    expect(v.usable.total).toBeNull();
    expect(v.stockState.coverageDays).toBeNull();
    expect(v.suggestion.refusals).toContain("ESTOQUE_VIRTUAL");
  });

  /** Política do SKU vence a da marca, que vence o padrão — a peça decide, e o arranjo a respeita. */
  it("a política mais específica ganha", () => {
    const v = composeSkuReplenishment(LINHA, [
      PADRAO,
      { ...PADRAO, supplierBrand: "VAZ", skuId: null, leadTimeDays: 3 },
      { ...PADRAO, supplierBrand: null, skuId: LINHA.sku_id, leadTimeDays: 1 },
    ]);

    expect(v.policy?.scope).toBe("SKU");
    expect(v.policy?.leadTimeDays).toBe(1);
  });
});
