import { describe, expect, it } from "vitest";

import { formatDecisionSnapshot, OUTCOME_WINDOWS_DAYS, outcomeWindowLabel } from "./decision-format.js";

/**
 * O texto que a Central de Ações e a aba Decisões do SKU mostram para um
 * snapshot (D-228). O que importa fixar é a HONESTIDADE do formato: preço
 * ausente vira "—", nunca R$ 0,00; snapshot vazio diz por que está vazio.
 */
describe("formatDecisionSnapshot", () => {
  it("imprime os três números do snapshot lado a lado", () => {
    const texto = formatDecisionSnapshot({
      as_of: "2026-08-23",
      units_sold_7d: 55,
      avg_daily_units_7d: 7.86,
      avg_price_7d: 287.03,
      stock_local: -1734,
    });

    expect(texto).toContain("Vendido (7d): 55");
    expect(texto).toContain("R$");
    expect(texto).toContain("287,03");
    expect(texto).toContain("Estoque local: -1734");
  });

  it("preço médio ausente vira —, não R$ 0,00", () => {
    // SKU sem venda nos 7 dias: `avg_price_7d` é NULL no banco (a razão não
    // existe) e chega como `null` no JSON.
    const texto = formatDecisionSnapshot({ units_sold_7d: 0, avg_price_7d: null, stock_local: 12 });

    expect(texto).toContain("Preço médio: —");
    expect(texto).not.toContain("R$ 0,00");
  });

  it("snapshot vazio diz o motivo, e valor que não é objeto não quebra a tela", () => {
    expect(formatDecisionSnapshot({})).toBe("Sem dado (ação sem SKU vinculado).");
    expect(formatDecisionSnapshot(null)).toBe("Sem dado.");
    expect(formatDecisionSnapshot("texto")).toBe("Sem dado.");
    expect(formatDecisionSnapshot([1, 2])).toBe("Sem dado.");
  });
});

describe("janelas de medição", () => {
  it("são as três de D-065, em ordem", () => {
    expect(OUTCOME_WINDOWS_DAYS).toEqual([7, 15, 30]);
    expect(outcomeWindowLabel(7)).toBe("7 dias depois");
  });
});
