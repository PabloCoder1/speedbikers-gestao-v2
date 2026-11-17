import type { ReplenishmentSetting } from "@sb/domain";
import { describe, expect, it } from "vitest";

import { avaliarSku, lerAnalise, type AvaliacaoSku } from "../../../../lib/purchase-analysis";
import {
  camposDoItem,
  classificarParaRevisao,
  impactoDaRevisao,
  planoDoLote,
  quantidadeParaReduzir,
  registrosDeDecisao,
  type DecisaoItem,
  type ItemRetirado,
  type LinhaRevisao,
} from "./revisao-pedido";

const PADRAO: ReplenishmentSetting = {
  supplierBrand: null,
  skuId: null,
  leadTimeDays: 15,
  targetCoverageDays: 30,
  safetyStockDays: 15,
  maxCoverageDays: null,
  policyNote: null,
};

/** Uma avaliação pelo caminho real: contrato da RPC → domínio. */
function avaliacao(over: Record<string, unknown>, noPedido: number, margem: number | null = 0.3): AvaliacaoSku {
  const lida = lerAnalise({
    data: "2026-11-16",
    new_product_days: 60,
    margem_minima: 0.1,
    linhas: [
      {
        sku_id: "11111111-1111-4111-8111-111111111111",
        sku: "SKU",
        title: null,
        supplier_brand: null,
        purchase_cost: 10,
        stock_is_virtual: false,
        na_reposicao: true,
        local_quantity: 10,
        reservado: 0,
        transito: 0,
        full_quantity: 0,
        units_15d: 30,
        units_30d: 60,
        units_60d: 120,
        units_90d: 180,
        history_days_90: 90,
        abc_class: "A",
        is_discontinued: false,
        kind: "PRODUTO",
        days_since_created: 400,
        days_since_first_sale: 400,
        stockout_days_30: 0,
        other_open_quantity: 0,
        other_open_orders: [],
        last_purchase: null,
        supplier_rule: null,
        preferred_supplier: null,
        ...over,
      },
    ],
  });
  const linha = lida?.linhas[0];

  if (linha === undefined) throw new Error("contrato");

  const total =
    margem === null
      ? null
      : {
          units: 1,
          orders: 1,
          revenue: 100,
          coveredOrders: 1,
          coveredRevenue: 100,
          coveredReceived: 100 * margem + 50,
          coveredCost: 50,
          currentCostOrders: 0,
          avaliacao: { margin: margem, coverage: 1, quality: "CONFIAVEL" as const, result: 100 * margem },
        };

  return avaliarSku(linha, { skuId: linha.sku_id, total, porMarketplace: [], porConta: [] }, [PADRAO], { margemMinima: 0.1, newProductDays: 60 }, noPedido);
}

const ALTO_GIRO = {}; // 2/dia, 10 em estoque: comprar 110.
const BAIXO_GIRO = { local_quantity: 94, units_15d: 4, units_30d: 8, units_60d: 16, units_90d: 24 };

function linha(key: string, quantidade: number, custo: number | null, av: AvaliacaoSku | null): LinhaRevisao {
  return { key, skuId: key, sku: key.toUpperCase(), quantidade, custo, avaliacao: av };
}

describe("classificarParaRevisao", () => {
  it("separa comprar, avaliar, retirar, margem e sem dados", () => {
    expect(classificarParaRevisao(avaliacao(ALTO_GIRO, 100))).toBe("COMPRAR");
    expect(classificarParaRevisao(avaliacao(ALTO_GIRO, 300))).toBe("AVALIAR");
    expect(classificarParaRevisao(avaliacao(BAIXO_GIRO, 50))).toBe("RETIRAR");
    expect(classificarParaRevisao(avaliacao(ALTO_GIRO, 100, 0.04))).toBe("MARGEM");
    expect(classificarParaRevisao(avaliacao({ history_days_90: 30 }, 10))).toBe("SEM_DADOS");
    expect(classificarParaRevisao(null)).toBe("SEM_DADOS");
  });
});

describe("decisões do comprador", () => {
  const retirar = linha("a", 50, 20, avaliacao(BAIXO_GIRO, 50));
  const reduzir = linha("b", 300, 10, avaliacao(ALTO_GIRO, 300));
  const comprar = linha("c", 100, null, avaliacao(ALTO_GIRO, 100));

  it("reduzir vai até a recomendada; zero é retirar, não reduzir", () => {
    expect(quantidadeParaReduzir(reduzir)).toBe(110);
    expect(quantidadeParaReduzir(retirar)).toBeNull();
  });

  it("o lote aplica retirar e reduzir, nunca mexe no que é para manter", () => {
    expect(planoDoLote([retirar, reduzir, comprar])).toEqual([
      { key: "a", acao: "RETIRAR", quantidade: 0 },
      { key: "b", acao: "REDUZIR", quantidade: 110 },
    ]);
  });

  it("manter com justificativa: o item guarda a decisão e o histórico também", () => {
    const decisoes = new Map<string, DecisaoItem>([["b", { decision: "MANTER", reason: "CAMPANHA", note: " Black Friday ", quantityBefore: 300 }]]);

    expect(camposDoItem(reduzir, decisoes.get("b"))).toEqual({
      recommendedQuantity: 110,
      reviewRecommendation: "REDUZIR",
      reviewDecision: "MANTER",
      reviewReason: "CAMPANHA",
      reviewNote: "Black Friday",
    });
    expect(registrosDeDecisao([reduzir], [], decisoes)).toEqual([
      {
        skuId: "b",
        skuSnapshot: "B",
        recommendation: "REDUZIR",
        decision: "MANTER",
        quantityBefore: 300,
        quantityAfter: 300,
        recommendedQuantity: 110,
        reason: "CAMPANHA",
        note: "Black Friday",
        unitCost: 10,
      },
    ]);
  });

  it("o item retirado sai do pedido e entra no histórico com quantidade final zero", () => {
    const retirado: ItemRetirado = {
      key: "a",
      skuId: "a",
      sku: "A",
      titulo: null,
      quantidade: 50,
      custo: 20,
      recommendation: "RETIRAR",
      recommendedQuantity: 0,
      reason: null,
      note: "",
    };

    expect(registrosDeDecisao([], [retirado], new Map())).toEqual([
      expect.objectContaining({ decision: "RETIRAR", quantityBefore: 50, quantityAfter: 0, unitCost: 20 }),
    ]);
  });

  it("alterar a escolha: reduzir e depois voltar à quantidade original vira manter", () => {
    const decisoes = new Map<string, DecisaoItem>([["b", { decision: "REDUZIR", reason: null, note: "", quantityBefore: 300 }]]);

    expect(registrosDeDecisao([reduzir], [], decisoes)[0]?.decision).toBe("MANTER");
  });
});

describe("impactoDaRevisao", () => {
  it("confere totais depois das decisões, com o valor retirado à parte e o parcial dito", () => {
    const reduzida = linha("b", 110, 10, avaliacao(ALTO_GIRO, 110));
    const semCusto = linha("c", 100, null, avaliacao(ALTO_GIRO, 100));
    const retirado: ItemRetirado = {
      key: "a",
      skuId: "a",
      sku: "A",
      titulo: null,
      quantidade: 50,
      custo: 20,
      recommendation: "RETIRAR",
      recommendedQuantity: 0,
      reason: null,
      note: "",
    };
    const decisoes = new Map<string, DecisaoItem>([["b", { decision: "REDUZIR", reason: null, note: "", quantityBefore: 300 }]]);
    const i = impactoDaRevisao([reduzida, semCusto], [retirado], decisoes);

    expect(i).toMatchObject({
      itens: 2,
      unidades: 210,
      valor: 1100,
      valorParcial: true,
      retirados: 1,
      unidadesRetiradas: 50,
      valorRetirado: 1000,
      reduzidos: 1,
      unidadesReduzidas: 190,
      prioridade: 2,
    });
  });
});
