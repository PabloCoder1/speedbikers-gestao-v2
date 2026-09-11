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

  it("sem linha de cobertura a tela diz isso, e não inventa zero", () => {
    const r = descreverCobertura(null);

    expect(r.dias).toBeNull();
    expect(r.valor).toBe("—");
    expect(r.ressalva).toBe("não calculada para este SKU");
  });
});
