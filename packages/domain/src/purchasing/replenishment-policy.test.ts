import { describe, expect, it } from "vitest";

import type { ReplenishmentSetting } from "./replenishment-policy.js";
import { demandWindowDays, resolveReplenishmentPolicy } from "./replenishment-policy.js";

const padrao: ReplenishmentSetting = {
  supplierBrand: null,
  skuId: null,
  leadTimeDays: 15,
  targetCoverageDays: 30,
  safetyStockDays: 7,
  maxCoverageDays: null,
  policyNote: null,
};

const navetec: ReplenishmentSetting = {
  supplierBrand: "NAVETEC",
  skuId: null,
  leadTimeDays: 60,
  targetCoverageDays: 90,
  safetyStockDays: 15,
  maxCoverageDays: 240,
  policyNote: "importação — pedido consolidado",
};

const porSku: ReplenishmentSetting = {
  supplierBrand: null,
  skuId: "sku-especial",
  leadTimeDays: 5,
  targetCoverageDays: 10,
  safetyStockDays: 0,
  maxCoverageDays: null,
  policyNote: null,
};

const TODAS = [padrao, navetec, porSku];

describe("resolveReplenishmentPolicy — o mais específico vence", () => {
  it("SKU vence marca e padrão", () => {
    const r = resolveReplenishmentPolicy(TODAS, { id: "sku-especial", supplierBrand: "NAVETEC" });

    expect(r?.scope).toBe("SKU");
    expect(r?.leadTimeDays).toBe(5);
  });

  it("marca vence o padrão", () => {
    const r = resolveReplenishmentPolicy(TODAS, { id: "outro", supplierBrand: "NAVETEC" });

    expect(r?.scope).toBe("MARCA");
    expect(r?.targetCoverageDays).toBe(90);
  });

  it("sem marca e sem regra própria, cai no padrão da organização", () => {
    const r = resolveReplenishmentPolicy(TODAS, { id: "outro", supplierBrand: null });

    expect(r?.scope).toBe("PADRAO");
    expect(r?.leadTimeDays).toBe(15);
  });

  /**
   * A recusa é o ponto do desenho: sem configuração aplicável, a resposta é
   * `null` e quem chama NÃO sugere compra — mesmo padrão de
   * `stock_is_virtual` na cobertura (D-127). Inventar um default aqui seria
   * exatamente o "número errado com aparência de certo" que a Regra de
   * Progressão proíbe.
   */
  it("sem configuração nenhuma devolve null — a sugestão RECUSA, não inventa", () => {
    expect(resolveReplenishmentPolicy([], { id: "x", supplierBrand: "NAVETEC" })).toBeNull();
  });

  /**
   * 64% dos SKUs ainda não têm `supplier_brand` (D-129, vazio de propósito).
   * SKU sem marca não pode casar com configuração de marca nenhuma — cairia
   * na política errada em silêncio.
   */
  it("SKU sem marca ignora configurações de marca, mesmo sendo a única existente", () => {
    expect(resolveReplenishmentPolicy([navetec], { id: "x", supplierBrand: null })).toBeNull();
  });

  it("marca diferente não casa", () => {
    const r = resolveReplenishmentPolicy([navetec, padrao], { id: "x", supplierBrand: "OFF RACER" });

    expect(r?.scope).toBe("PADRAO");
  });
});

describe("demandWindowDays — lead time SOMA, nunca substitui", () => {
  /**
   * A armadilha nomeada no PRD: "comprar 15 dias de estoque com 15 dias de
   * prazo zera antes da entrega". A janela de demanda é lead + cobertura +
   * segurança — 15+30+7 = 52, nunca 30.
   */
  it("janela = lead + cobertura + segurança", () => {
    expect(demandWindowDays({ ...padrao, scope: "PADRAO" })).toBe(52);
    expect(demandWindowDays({ ...navetec, scope: "MARCA" })).toBe(165);
  });
});
