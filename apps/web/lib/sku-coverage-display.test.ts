import { describe, expect, it } from "vitest";

import { descreverCobertura } from "./sku-coverage-display";

/**
 * A cobertura do SKU em texto (D-314).
 *
 * O caso que dá nome à fatia é o primeiro: o SKU do seed tem 50 locais, 3 no
 * Full e vende 5 em 30 dias. A conta antiga (`local ÷ venda média`) dava
 * **300**; a canônica dá **318**, que é o que `/reposicao` mostra para o mesmo
 * SKU. Duas telas, um número.
 */
const SEED = {
  local: 50,
  full: 3,
  transito: 0,
  reservado: 0,
  stockIsVirtual: false,
  units15: 5,
  units30: 5,
  units60: 5,
  units90: 5,
  historyDays90: 90,
  // Sem loja Shopee em produção com pedidos lidos: a venda é só a do ML (D-466).
  units30Shopee: null,
};

describe("descreverCobertura", () => {
  it("soma o aproveitável: o SKU do seed sai em 318, não em 300", () => {
    const r = descreverCobertura(SEED);

    expect(r.dias).toBe(318);
    expect(r.valor).toBe("318,0 dias");
    // 50 ÷ (5/30) = 300 — a conta que D-288 aposentou. Se ela voltar, cai aqui.
    expect(r.valor).not.toContain("300");
  });

  it("a ressalva carrega a CONTA, e o título carrega as parcelas", () => {
    const r = descreverCobertura(SEED);

    expect(r.ressalva).toBe("aproveitável 53 ÷ 0,17/dia");
    expect(r.titulo).toContain("local 50 + Full 3 + trânsito 0");
    expect(r.titulo).toContain("reservado 0 fica fora");
  });

  it("reservado NÃO entra no dividendo — está comprometido", () => {
    const r = descreverCobertura({ ...SEED, reservado: 20 });

    expect(r.ressalva).toContain("aproveitável 53");
    expect(r.titulo).toContain("reservado 20 fica fora");
  });

  it("estoque virtual fica em branco COM MOTIVO, nunca em zero (D-127)", () => {
    const r = descreverCobertura({ ...SEED, stockIsVirtual: true });

    expect(r.dias).toBeNull();
    expect(r.valor).toBe("—");
    expect(r.ressalva).toContain("sentinela");
  });

  it("sem venda na janela a cobertura é INDEFINIDA, não infinita (D-080)", () => {
    const r = descreverCobertura({ ...SEED, units15: 0, units30: 0, units60: 0, units90: 0 });

    expect(r.dias).toBeNull();
    expect(r.valor).toBe("—");
    expect(r.ressalva).toContain("não há taxa para dividir");
    // E as parcelas continuam no título: o estoque existe, o divisor é que não.
    expect(r.titulo).toContain("local 50");
  });

  it("aproveitável negativo vira 0,0 dias — devendo estoque ainda é zero para vender", () => {
    const r = descreverCobertura({ ...SEED, local: -5, full: 0 });

    expect(r.dias).toBe(0);
    expect(r.valor).toBe("0,0 dias");
  });

  it("a Shopee na venda (D-466): a taxa já a soma, e o título diz quanto veio de lá", () => {
    const r = descreverCobertura({ ...SEED, units15: 8, units30: 9, units60: 9, units90: 9, units30Shopee: 4 });

    // 53 ÷ (9/30) — a mesma conta, com a Shopee dentro da taxa.
    expect(r.ressalva).toBe("aproveitável 53 ÷ 0,30/dia");
    expect(r.titulo).toContain("A venda de 30 dias soma o ML e a Shopee: 4 un vieram da Shopee");
  });

  it("Shopee na conta sem venda dela, ou fora da conta: o título não ganha texto", () => {
    expect(descreverCobertura({ ...SEED, units30Shopee: 0 }).titulo).not.toContain("Shopee");
    expect(descreverCobertura(SEED).titulo).not.toContain("Shopee");
  });

  it("sem venda com a Shopee na conta diz que é nos dois canais; fora da conta, não promete a Shopee", () => {
    const zerado = { ...SEED, units15: 0, units30: 0, units60: 0, units90: 0 };

    expect(descreverCobertura({ ...zerado, units30Shopee: 0 }).ressalva).toBe(
      "sem venda nos últimos 30 dias, no ML nem na Shopee — não há taxa para dividir",
    );
    expect(descreverCobertura(zerado).ressalva).toBe("sem venda nos últimos 30 dias — não há taxa para dividir");
  });

  it("sem linha de cobertura a tela diz isso, e não inventa zero", () => {
    const r = descreverCobertura(null);

    expect(r.dias).toBeNull();
    expect(r.valor).toBe("—");
    expect(r.ressalva).toBe("não calculada para este SKU");
  });
});
