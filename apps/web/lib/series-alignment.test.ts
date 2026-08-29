import { describe, expect, it } from "vitest";

import { indexByOffset, offsetInPeriod } from "./series-alignment";

describe("offsetInPeriod", () => {
  it("primeiro dia é 0 e o offset cresce com o calendário, não com a lista", () => {
    expect(offsetInPeriod("2026-08-01", "2026-08-01")).toBe(0);
    expect(offsetInPeriod("2026-08-02", "2026-08-01")).toBe(1);
    expect(offsetInPeriod("2026-08-30", "2026-08-01")).toBe(29);
  });

  it("atravessa fim de mês", () => {
    expect(offsetInPeriod("2026-08-01", "2026-07-31")).toBe(1);
    expect(offsetInPeriod("2026-08-29", "2026-07-31")).toBe(29);
  });
});

describe("indexByOffset — a trava do alinhamento entre períodos", () => {
  /**
   * ESTE é o teste que justifica a fatia inteira (D-137).
   *
   * Cenário deliberadamente assimétrico: a janela atual perdeu UM dia no
   * meio (dia 2 sem métrica calculada) e a anterior está completa. É o estado
   * que a própria tela já prevê ao exibir "Só N dias têm métrica calculada".
   *
   * Por índice, o terceiro ponto da série atual (03/08, offset 2) cairia ao
   * lado do terceiro ponto da anterior (03/07, offset 2)... por acidente de
   * contagem, não por correspondência de dia. O teste abaixo prova que o
   * offset devolve a correspondência CERTA mesmo com a lacuna: o dia 4 da
   * janela atual encontra o dia 4 da anterior, não o "quarto item da lista".
   */
  it("lacuna numa janela não desloca a correspondência com a outra", () => {
    const atual = [
      { metric_date: "2026-08-01", valor: 10 },
      { metric_date: "2026-08-02", valor: 20 },
      // 2026-08-03 AUSENTE — sem métrica calculada
      { metric_date: "2026-08-04", valor: 40 },
    ];
    const anterior = [
      { metric_date: "2026-07-01", valor: 1 },
      { metric_date: "2026-07-02", valor: 2 },
      { metric_date: "2026-07-03", valor: 3 },
      { metric_date: "2026-07-04", valor: 4 },
    ];

    const atualPorOffset = indexByOffset(atual, "2026-08-01");
    const anteriorPorOffset = indexByOffset(anterior, "2026-07-01");

    // 04/08 é o dia 3 da janela e encontra 04/07, que também é o dia 3.
    expect(atualPorOffset.get(3)?.valor).toBe(40);
    expect(anteriorPorOffset.get(3)?.valor).toBe(4);

    // Se o alinhamento fosse por índice, 04/08 seria o item 2 da lista e
    // encontraria 03/07 (valor 3) — um dia antes. É esse erro que o offset
    // impede, e ele é INVISÍVEL na tela: as duas linhas continuariam bonitas.
    expect(anterior[2]?.valor).toBe(3);
    expect(anteriorPorOffset.get(3)?.valor).not.toBe(anterior[2]?.valor);
  });

  it("dia ausente do outro lado devolve undefined, nunca 0", () => {
    const anterior = [{ metric_date: "2026-07-01", valor: 1 }];
    const porOffset = indexByOffset(anterior, "2026-07-01");

    // "sem dado" e "vendeu zero" são afirmações diferentes sobre o negócio.
    expect(porOffset.get(5)).toBeUndefined();
    expect(porOffset.get(0)?.valor).toBe(1);
  });

  it("série vazia produz mapa vazio, sem lançar", () => {
    expect(indexByOffset([], "2026-07-01").size).toBe(0);
  });
});
