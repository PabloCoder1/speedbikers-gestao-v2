import { describe, expect, it } from "vitest";

import { adjustToSupplierRules, assessPurchaseFit, type PurchaseFitInput } from "./purchase-fit.js";
import type { ReplenishmentSetting } from "./replenishment-policy.js";
import { composeSkuReplenishment, type SkuReplenishmentRow } from "./sku-replenishment.js";

/**
 * A avaliação de compra (D-721). Cada caso monta o veredito pela composição
 * REAL (D-293) — a avaliação nunca recebe um veredito inventado, para que um
 * ajuste nas peças canônicas apareça aqui.
 */

const PADRAO: ReplenishmentSetting = {
  supplierBrand: null,
  skuId: null,
  leadTimeDays: 15,
  targetCoverageDays: 30,
  safetyStockDays: 15,
  maxCoverageDays: null,
  policyNote: null,
};

const COM_TETO: ReplenishmentSetting = { ...PADRAO, maxCoverageDays: 120 };

function linha(over: Partial<SkuReplenishmentRow> = {}): SkuReplenishmentRow {
  return {
    sku_id: "11111111-1111-4111-8111-111111111111",
    sku: "20017",
    title: "Retentor",
    supplier_brand: null,
    local_quantity: 10,
    full_quantity: 0,
    transito: 0,
    reservado: 0,
    stock_is_virtual: false,
    units_15d: 30,
    units_30d: 60,
    units_60d: 120,
    units_90d: 180,
    history_days_90: 90,
    ...over,
  };
}

function avaliar(
  row: SkuReplenishmentRow,
  over: Partial<Omit<PurchaseFitInput, "verdict">> = {},
  settings: readonly ReplenishmentSetting[] = [PADRAO],
) {
  return assessPurchaseFit({
    verdict: composeSkuReplenishment(row, settings),
    units90d: row.units_90d,
    orderedQuantity: null,
    otherOpenQuantity: 0,
    daysSinceFirstSale: 400,
    daysSinceCreated: 400,
    stockoutDays30: 0,
    isDiscontinued: false,
    margin: 0.3,
    marginQuality: "CONFIAVEL",
    minimumOrderQuantity: null,
    packMultiple: null,
    preferences: { marginFloor: 0.1, newProductDays: 60 },
    ...over,
  });
}

const codes = (r: ReturnType<typeof avaliar>) => r.reasons.map((x) => x.code);

describe("assessPurchaseFit — reposição", () => {
  it("alto giro com boa margem: comprar agora, com a sugestão como recomendação", () => {
    // 2/dia, 10 em estoque → 5 dias de cobertura < prazo 15.
    const r = avaliar(linha());

    expect(r.situation).toBe("COMPRAR_AGORA");
    expect(r.turnover).toBe("ALTO");
    expect(r.recommendedQuantity).toBe(110); // 2 × 60 − 10
    expect(r.confidence).toBe("ALTA");
    expect(codes(r)).toContain("COBERTURA_ABAIXO_DO_PRAZO");
  });

  it("o exemplo do 20017: 8/mês, 94 em estoque, 50 no pedido → retirar", () => {
    const row = linha({ local_quantity: 94, units_15d: 4, units_30d: 8, units_60d: 16, units_90d: 24 });
    const r = avaliar(row, { orderedQuantity: 50 });

    expect(r.recommendation).toBe("RETIRAR");
    expect(r.recommendedQuantity).toBe(0);
    expect(r.turnover).toBe("BAIXO");
    expect(r.coverageDays).toBeCloseTo(352.5, 0);
    expect(codes(r)).toContain("COBERTURA_JA_ATENDE");
  });

  it("pedido acima da sugestão → reduzir até a sugestão", () => {
    const r = avaliar(linha(), { orderedQuantity: 300 });

    expect(r.recommendation).toBe("REDUZIR");
    expect(r.recommendedQuantity).toBe(110);
    expect(codes(r)).toContain("ACIMA_DA_SUGESTAO");
  });

  it("pedido dentro da sugestão → manter", () => {
    expect(avaliar(linha(), { orderedQuantity: 100 }).recommendation).toBe("MANTER");
  });

  it("estoque Full e trânsito entram no aproveitável e reduzem a sugestão", () => {
    const r = avaliar(linha({ full_quantity: 40, transito: 30 }));

    expect(r.recommendedQuantity).toBe(40); // 120 − (10 + 40 + 30)
  });

  it("pedido sobreposto (rascunho/aprovado fora do trânsito) desconta da recomendação", () => {
    const r = avaliar(linha(), { otherOpenQuantity: 110, orderedQuantity: 50 });

    expect(r.recommendedQuantity).toBe(0);
    expect(r.situation).toBe("COBERTO_POR_PEDIDOS");
    expect(r.recommendation).toBe("RETIRAR");
    expect(codes(r)).toContain("PEDIDO_SOBREPOSTO");
  });

  it("estoque acima do teto da política → excesso, e o pedido passa do teto", () => {
    const row = linha({ local_quantity: 300 });
    const r = avaliar(row, { orderedQuantity: 20 }, [COM_TETO]);

    expect(r.situation).toBe("ESTOQUE_EM_EXCESSO");
    expect(r.recommendation).toBe("RETIRAR");
    expect(codes(r)).toContain("ACIMA_DO_TETO");
  });

  it("sem venda em 90 dias com estoque → parado e baixo giro", () => {
    const row = linha({ local_quantity: 40, units_15d: 0, units_30d: 0, units_60d: 0, units_90d: 0 });
    const r = avaliar(row, { orderedQuantity: 10, margin: null, marginQuality: "INDISPONIVEL" });

    expect(r.turnover).toBe("PARADO");
    expect(r.situation).toBe("BAIXO_GIRO");
    expect(r.recommendation).toBe("RETIRAR");
    expect(codes(r)).toContain("SEM_VENDA_90D");
  });

  it("produto recente com pouca venda: nunca 'retirar', sempre em observação", () => {
    const row = linha({ local_quantity: 50, units_15d: 2, units_30d: 3, units_60d: 3, units_90d: 3 });
    const r = avaliar(row, { orderedQuantity: 20, daysSinceFirstSale: 25 });

    expect(r.situation).toBe("PRODUTO_RECENTE");
    expect(r.recommendation).toBe("MANTER");
    expect(r.confidence).toBe("BAIXA");
  });

  it("produto cadastrado há pouco e que nunca vendeu é recente pela data de cadastro", () => {
    const row = linha({ local_quantity: 0, units_15d: 0, units_30d: 0, units_60d: 0, units_90d: 0 });
    const r = avaliar(row, { daysSinceFirstSale: null, daysSinceCreated: 10 });

    expect(r.situation).toBe("PRODUTO_RECENTE");
  });

  it("ruptura no período: venda subestimada, retirada vira revisar", () => {
    const row = linha({ local_quantity: 94, units_15d: 4, units_30d: 8, units_60d: 16, units_90d: 24 });
    const r = avaliar(row, { orderedQuantity: 50, stockoutDays30: 12 });

    expect(r.recommendation).toBe("REVISAR");
    expect(codes(r)).toContain("RUPTURA_NO_PERIODO");
    expect(r.confidence).toBe("BAIXA");
  });

  it("disponibilidade desconhecida rebaixa a confiança para média", () => {
    expect(avaliar(linha(), { stockoutDays30: null }).confidence).toBe("MEDIA");
  });

  it("histórico incompleto: sem número e dados insuficientes", () => {
    const r = avaliar(linha({ history_days_90: 40 }), { orderedQuantity: 30 });

    expect(r.situation).toBe("DADOS_INSUFICIENTES");
    expect(r.recommendedQuantity).toBeNull();
    expect(r.recommendation).toBeNull();
    expect(codes(r)).toContain("HISTORICO_INCOMPLETO");
  });

  it("estoque virtual recusa número", () => {
    const r = avaliar(linha({ stock_is_virtual: true }));

    expect(r.recommendedQuantity).toBeNull();
    expect(codes(r)).toContain("ESTOQUE_VIRTUAL");
  });

  it("sem política: dados insuficientes", () => {
    const r = avaliar(linha(), {}, []);

    expect(r.situation).toBe("DADOS_INSUFICIENTES");
    expect(codes(r)).toContain("SEM_CONFIGURACAO");
  });

  it("política por SKU vence a da organização", () => {
    const sku: ReplenishmentSetting = { ...PADRAO, skuId: linha().sku_id, leadTimeDays: 5, targetCoverageDays: 10, safetyStockDays: 0 };
    const r = avaliar(linha(), {}, [PADRAO, sku]);

    expect(r.recommendedQuantity).toBe(20); // 2 × 15 − 10
  });

  it("demanda crescente e em queda viram motivos", () => {
    const sobe = avaliar(linha({ units_15d: 50, units_30d: 90, units_60d: 120, units_90d: 150 }));
    const cai = avaliar(linha({ local_quantity: 400, units_15d: 5, units_30d: 10, units_60d: 60, units_90d: 110 }));

    expect(codes(sobe)).toContain("DEMANDA_CRESCENDO");
    expect(codes(cai)).toContain("DEMANDA_EM_QUEDA");
    expect(cai.situation).toBe("BAIXO_GIRO");
  });

  it("descontinuado: recomendação zero e retirar", () => {
    const r = avaliar(linha(), { isDiscontinued: true, orderedQuantity: 20 });

    expect(r.recommendation).toBe("RETIRAR");
    expect(r.recommendedQuantity).toBe(0);
    expect(r.situation).toBe("REVISAR");
  });
});

describe("assessPurchaseFit — margem × giro", () => {
  it("alto giro e margem baixa: compra mantida, com aviso de negociar", () => {
    const r = avaliar(linha(), { margin: 0.04, orderedQuantity: 100 });

    expect(r.recommendation).toBe("MANTER");
    expect(r.marginBand).toBe("ABAIXO_DO_MINIMO");
    expect(r.situation).toBe("COMPRAR_AGORA"); // não bloqueia o urgente
    expect(codes(r)).toContain("MARGEM_ABAIXO_DO_MINIMO");
  });

  it("baixo giro e margem baixa: margem insuficiente e retirar", () => {
    const row = linha({ local_quantity: 200, units_15d: 15, units_30d: 30, units_60d: 60, units_90d: 90 });
    const r = avaliar(row, { margin: 0.05, orderedQuantity: 30 });

    expect(r.situation).toBe("MARGEM_INSUFICIENTE");
    expect(r.recommendation).toBe("RETIRAR");
  });

  it("baixo giro e margem alta: a margem não justifica comprar mais", () => {
    const row = linha({ local_quantity: 200, units_15d: 15, units_30d: 30, units_60d: 60, units_90d: 90 });

    expect(avaliar(row, { margin: 0.45, orderedQuantity: 30 }).recommendation).toBe("RETIRAR");
  });

  it("margem negativa: revisar mesmo dentro da sugestão", () => {
    const r = avaliar(linha(), { margin: -0.08, orderedQuantity: 50 });

    expect(r.recommendation).toBe("REVISAR");
    expect(r.situation).toBe("MARGEM_INSUFICIENTE");
    expect(codes(r)).toContain("MARGEM_NEGATIVA");
  });

  it("margem zero real é abaixo do mínimo, não desconhecida", () => {
    expect(avaliar(linha(), { margin: 0 }).marginBand).toBe("ABAIXO_DO_MINIMO");
  });

  it("sem margem confiável: não assume positiva nem negativa", () => {
    const r = avaliar(linha(), { margin: null, marginQuality: "INDISPONIVEL", orderedQuantity: 50 });

    expect(r.marginBand).toBe("DESCONHECIDA");
    expect(r.recommendation).toBe("MANTER");
    expect(r.confidence).toBe("MEDIA");
    expect(codes(r)).toContain("MARGEM_DESCONHECIDA");
  });
});

describe("adjustToSupplierRules", () => {
  it("aplica o mínimo e o múltiplo, e zero continua zero", () => {
    expect(adjustToSupplierRules(7, 20, null)).toEqual({ quantity: 20, moqApplied: true, multipleApplied: false });
    expect(adjustToSupplierRules(23, null, 12)).toEqual({ quantity: 24, moqApplied: false, multipleApplied: true });
    expect(adjustToSupplierRules(7, 10, 12)).toEqual({ quantity: 12, moqApplied: true, multipleApplied: true });
    expect(adjustToSupplierRules(0, 10, 12).quantity).toBe(0);
  });

  it("MOQ aparece na recomendação da avaliação", () => {
    const r = avaliar(linha({ local_quantity: 115 }), { minimumOrderQuantity: 50 });

    expect(r.recommendedQuantity).toBe(50); // sugestão 5 → MOQ 50
    expect(r.reasons.map((x) => x.code)).toContain("ARREDONDADO_MOQ");
  });
});
