import { describe, expect, it } from "vitest";

import {
  lerItensDevolvidos,
  lerPorSituacao,
  lojaDeTesteDasDevolucoes,
  rotuloDaSolucao,
  separarResumoDevolucoes,
  type LinhaResumoDevolucoes,
} from "./devolucoes-shopee";

function linha(sobre: Partial<LinhaResumoDevolucoes>): LinhaResumoDevolucoes {
  return {
    nivel: "CONTA",
    account_id: "5bf2ce24-4c02-4c8b-a1d7-a7973bbc96c4",
    account_name: "Speed Bikers Oficial",
    environment: "live",
    devolucoes: 3,
    pedidos_com_devolucao: 3,
    so_reembolso: 1,
    unidades: 4,
    valor_reembolso: 210.5,
    por_situacao: { REQUESTED: { devolucoes: 1, valor_reembolso: 60, unidades: 1 } },
    ultima_atualizacao: "2026-10-15T10:00:00+00:00",
    ...sobre,
  };
}

/** Devoluções nunca lidas: tudo nulo (D-447). */
const NUNCA_LIDA = linha({
  account_name: "Loja de teste",
  environment: "sandbox",
  devolucoes: null,
  pedidos_com_devolucao: null,
  so_reembolso: null,
  unidades: null,
  valor_reembolso: null,
  por_situacao: null,
  ultima_atualizacao: null,
});

describe("separarResumoDevolucoes (D-460)", () => {
  it("separa o TOTAL das lojas, sem somar nada", () => {
    const total = linha({ nivel: "TOTAL", account_id: null, account_name: null, environment: null });
    const r = separarResumoDevolucoes([total, linha({}), NUNCA_LIDA]);

    expect(r.total).toBe(total);
    expect(r.lojas).toHaveLength(2);
  });

  it("sem loja real lida não há TOTAL — e isso não vira um total de zeros", () => {
    expect(separarResumoDevolucoes([NUNCA_LIDA]).total).toBeNull();
    expect(separarResumoDevolucoes(null)).toEqual({ total: null, lojas: [] });
  });

  it("a loja de teste é marcada; a real e o TOTAL (sem ambiente) não", () => {
    expect(lojaDeTesteDasDevolucoes(NUNCA_LIDA)).toBe(true);
    expect(lojaDeTesteDasDevolucoes(linha({}))).toBe(false);
    expect(lojaDeTesteDasDevolucoes({ environment: null })).toBe(false);
  });
});

describe("lerPorSituacao (D-460)", () => {
  it("a situação vem como a Shopee manda, da com mais devoluções para a com menos", () => {
    const r = lerPorSituacao({
      CLOSED: { devolucoes: 1, valor_reembolso: 40, unidades: 1 },
      REQUESTED: { devolucoes: 3, valor_reembolso: 120.5, unidades: 4 },
      JUDGING: { devolucoes: 1, valor_reembolso: null, unidades: 2 },
    });

    expect(r?.map((s) => s.situacao)).toEqual(["REQUESTED", "CLOSED", "JUDGING"]);
    expect(r?.[0]).toEqual({ situacao: "REQUESTED", devolucoes: 3, valorReembolso: 120.5, unidades: 4 });
  });

  it("valor não informado continua nulo, nunca zero", () => {
    expect(lerPorSituacao({ JUDGING: { devolucoes: 1, valor_reembolso: null, unidades: 1 } })?.[0]?.valorReembolso).toBeNull();
  });

  it("sem devolução no período é a lista vazia; nulo (nunca lida) ou fora do contrato é nulo", () => {
    expect(lerPorSituacao({})).toEqual([]);
    expect(lerPorSituacao(null)).toBeNull();
    expect(lerPorSituacao({ REQUESTED: { devolucoes: "1", valor_reembolso: 1, unidades: 1 } })).toBeNull();
    expect(lerPorSituacao({ REQUESTED: { devolucoes: 1, unidades: 1 } })).toBeNull();
  });
});

describe("lerItensDevolvidos (D-460)", () => {
  it("lê os itens com o SKU, e o item sem vínculo fica com o SKU nulo", () => {
    const itens = lerItensDevolvidos([
      { item_id: 1, model_id: null, nome: "Manete", quantidade: 2, preco: 40, sku_id: "b2f0", sku: "E2E-SKU-001", vinculo_via: "SKU_DO_PEDIDO" },
      { item_id: 2, model_id: null, nome: "Sem vínculo", quantidade: 1, preco: 10, sku_id: null, sku: null, vinculo_via: null },
    ]);

    expect(itens).toEqual([
      { nome: "Manete", quantidade: 2, skuId: "b2f0", sku: "E2E-SKU-001" },
      { nome: "Sem vínculo", quantidade: 1, skuId: null, sku: null },
    ]);
  });

  it("fora do contrato é nulo, e a tela diz que os itens não foram lidos", () => {
    expect(lerItensDevolvidos(null)).toBeNull();
    expect(lerItensDevolvidos([{ nome: 3, quantidade: 1, sku_id: null, sku: null }])).toBeNull();
  });
});

describe("rotuloDaSolucao (D-460)", () => {
  it("os dois valores do contrato em palavras; o resto como veio", () => {
    expect(rotuloDaSolucao("RETURN_REFUND")).toBe("devolução e reembolso");
    expect(rotuloDaSolucao("REFUND")).toBe("só reembolso");
    expect(rotuloDaSolucao("OUTRA")).toBe("OUTRA");
    expect(rotuloDaSolucao(null)).toBeNull();
  });
});
