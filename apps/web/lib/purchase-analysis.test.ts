import type { ReplenishmentSetting } from "@sb/domain";
import { describe, expect, it } from "vitest";

import { avaliarSku, lerAnalise, lerMargens } from "./purchase-analysis";
import { contextoDoMotivo, fraseDoMotivo, motivosOrdenados } from "./purchase-fit-vocabulary";

const SKU = "11111111-1111-4111-8111-111111111111";

const totais = (over: Record<string, unknown> = {}) => ({
  unidades: 10,
  pedidos: 10,
  receita: 1000,
  pedidos_cobertos: 10,
  receita_coberta: 1000,
  recebido_coberto: 830,
  custo_coberto: 500,
  pedidos_custo_atual: 0,
  ...over,
});

const margensRpc = {
  periodo: { de: "2026-10-18", ate: "2026-11-16" },
  margem_minima: 0.1,
  canais: { mercado_livre: { contas: 2 }, shopee: { lojas_lidas: 1 }, tiktok_shop: { lojas: 1, pedidos_lidos: false } },
  skus: [
    {
      sku_id: SKU,
      total: totais(),
      marketplaces: [{ marketplace: "MERCADO_LIVRE", ...totais() }],
      contas: [{ marketplace: "MERCADO_LIVRE", conta_id: "c1", conta: "Conta A", ...totais() }],
    },
  ],
};

const linhaRpc = (over: Record<string, unknown> = {}) => ({
  sku_id: SKU,
  sku: "20017",
  title: "Retentor",
  supplier_brand: null,
  purchase_cost: 50,
  stock_is_virtual: false,
  na_reposicao: true,
  local_quantity: 94,
  reservado: 0,
  transito: 0,
  full_quantity: 0,
  units_15d: 4,
  units_30d: 8,
  units_60d: 16,
  units_90d: 24,
  history_days_90: 90,
  abc_class: "C",
  units_30d_shopee: null,
  units_90d_shopee: null,
  is_discontinued: false,
  kind: "PRODUTO",
  days_since_created: 400,
  first_sale_date: "2025-06-01",
  days_since_first_sale: 400,
  stockout_days_30: 0,
  other_open_quantity: 0,
  other_open_orders: [],
  last_purchase: null,
  supplier_rule: null,
  preferred_supplier: null,
  ...over,
});

const analiseRpc = (linhas: unknown[]) => ({ data: "2026-11-16", new_product_days: 60, margem_minima: 0.1, linhas });

const PADRAO: ReplenishmentSetting = {
  supplierBrand: null,
  skuId: null,
  leadTimeDays: 15,
  targetCoverageDays: 30,
  safetyStockDays: 15,
  maxCoverageDays: null,
  policyNote: null,
};

describe("lerMargens", () => {
  it("lê o contrato e avalia cada recorte pela fórmula do domínio", () => {
    const m = lerMargens(margensRpc);

    expect(m?.lojasTiktok).toBe(1);
    expect(m?.porSku.get(SKU)?.total?.avaliacao.margin).toBe(0.33);
    expect(m?.porSku.get(SKU)?.porConta[0]?.conta).toBe("Conta A");
  });

  it("recusa a resposta INTEIRA quando um campo sai do contrato", () => {
    const quebrado = { ...margensRpc, skus: [{ ...margensRpc.skus[0], total: { ...totais(), pedidos: "10" } }] };

    expect(lerMargens(quebrado)).toBeNull();
    expect(lerMargens({ ...margensRpc, skus: [{ ...margensRpc.skus[0], marketplaces: [{ marketplace: "AMAZON", ...totais() }] }] })).toBeNull();
  });

  it("SKU sem venda no período: total nulo, não zero", () => {
    const m = lerMargens({ ...margensRpc, skus: [{ sku_id: SKU, total: null, marketplaces: [], contas: [] }] });

    expect(m?.porSku.get(SKU)?.total).toBeNull();
  });
});

describe("lerAnalise e avaliarSku", () => {
  it("o 20017 no pedido com 50: retirar, com a frase citando estoque e cobertura", () => {
    const a = lerAnalise(analiseRpc([linhaRpc()]));
    const m = lerMargens(margensRpc);
    const linha = a?.linhas[0];

    expect(linha).toBeDefined();

    if (linha === undefined || a === null) return;

    const av = avaliarSku(linha, m?.porSku.get(SKU) ?? null, [PADRAO], { margemMinima: a.margemMinima, newProductDays: a.newProductDays }, 50);

    expect(av.fit?.recommendation).toBe("RETIRAR");

    const fit = av.fit;

    if (fit === null) return;

    const ctx = contextoDoMotivo(fit, {
      units30d: 8,
      estoque: 94,
      sugestao: 0,
      noPedido: 50,
      margem: 0.33,
      margemMinima: 0.1,
      diasRuptura: 0,
      outrosPedidos: 0,
      tetoDias: null,
    });
    const frases = motivosOrdenados(fit).map((r) => fraseDoMotivo(r.code, ctx));

    expect(frases.some((f) => f.includes("94 un") && f.includes("352,5 dias"))).toBe(true);
  });

  it("SKU fora da reposição: sem avaliação, nunca uma recomendação inventada", () => {
    const a = lerAnalise(analiseRpc([linhaRpc({ na_reposicao: false, local_quantity: null, units_30d: null })]));
    const linha = a?.linhas[0];

    if (linha === undefined) throw new Error("linha");

    expect(avaliarSku(linha, null, [PADRAO], { margemMinima: 0.1, newProductDays: 60 }, 10).fit).toBeNull();
  });

  it("recusa linha fora do contrato", () => {
    expect(lerAnalise(analiseRpc([linhaRpc({ other_open_quantity: "3" })]))).toBeNull();
    expect(lerAnalise({ data: "x", linhas: [] })).toBeNull();
  });
});
