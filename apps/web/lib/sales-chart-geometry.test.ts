import { describe, expect, it } from "vitest";

import { caminho, faixaDoDia, tetoDaEscala, xPct, yPct } from "./sales-chart-geometry.js";

/**
 * A geometria do gráfico de vendas em porcentagem (A14, D-322). O que importa
 * fixar são as BORDAS: primeiro e último dia, período de um dia só, série em
 * zero — é onde uma conta em porcentagem sai da caixa sem avisar.
 */
describe("tetoDaEscala", () => {
  it("fica 10% acima do maior valor das duas séries juntas", () => {
    expect(tetoDaEscala([10, 40, 20])).toBeCloseTo(44);
  });

  it("série toda em zero dá 1, nunca um divisor zero", () => {
    expect(tetoDaEscala([0, 0])).toBe(1);
    expect(tetoDaEscala([])).toBe(1);
  });
});

describe("xPct e yPct", () => {
  it("o primeiro dia fica na borda esquerda e o último na direita", () => {
    expect(xPct(0, 30)).toBe(0);
    expect(xPct(29, 30)).toBe(100);
    expect(xPct(1, 3)).toBe(50);
  });

  it("período de um dia centra o ponto em vez de dividir por zero", () => {
    expect(xPct(0, 1)).toBe(50);
  });

  it("o teto fica no topo e o zero na linha de base", () => {
    expect(yPct(44, 44)).toBe(0);
    expect(yPct(0, 44)).toBe(100);
    expect(yPct(22, 44)).toBe(50);
  });
});

describe("faixaDoDia", () => {
  it("dias do meio têm meio passo para cada lado", () => {
    const faixa = faixaDoDia(1, 3);

    expect(faixa.esquerda).toBe(25);
    expect(faixa.largura).toBe(50);
  });

  it("as faixas das bordas são cortadas e não saem da área de plotagem", () => {
    expect(faixaDoDia(0, 3)).toEqual({ esquerda: 0, largura: 25 });
    expect(faixaDoDia(2, 3)).toEqual({ esquerda: 75, largura: 25 });
  });

  it("as faixas de um período cobrem a área inteira, sem buraco nem sobra", () => {
    const dias = 7;
    const total = Array.from({ length: dias }, (_unused, offset) => faixaDoDia(offset, dias).largura).reduce(
      (soma, largura) => soma + largura,
      0,
    );

    expect(total).toBeCloseTo(100);
  });

  it("período de um dia: a faixa é a área inteira", () => {
    expect(faixaDoDia(0, 1)).toEqual({ esquerda: 0, largura: 100 });
  });
});

describe("caminho", () => {
  it("começa com M, segue com L, em duas casas", () => {
    expect(
      caminho([
        { x: 0, y: 100 },
        { x: 50, y: 12.345 },
      ]),
    ).toBe("M0.00,100.00 L50.00,12.35");
  });

  it("série vazia dá caminho vazio", () => {
    expect(caminho([])).toBe("");
  });
});
