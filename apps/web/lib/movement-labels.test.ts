import { describe, expect, it } from "vitest";

import {
  formatQtyDelta,
  locationKindLabel,
  movementSourceLabel,
  movementTypeLabel,
} from "./movement-labels.js";
import { MOVEMENT_TYPES } from "./movement-filters.js";

describe("vocabulário das movimentações (D-167)", () => {
  it("os 12 tipos aprovados têm rótulo próprio — nenhum aparece cru", () => {
    for (const type of MOVEMENT_TYPES) {
      expect(movementTypeLabel(type)).not.toBe(type);
    }
  });

  it("tipo/local desconhecidos degradam para o valor cru — função total, nunca tela quebrada", () => {
    expect(movementTypeLabel("TIPO_NOVO")).toBe("TIPO_NOVO");
    expect(locationKindLabel("OUTRO")).toBe("OUTRO");
  });

  it("origem traduzida com o id junto; sem origem é o caso legítimo do ajuste manual", () => {
    expect(movementSourceLabel("ORDER", "20001234")).toBe("Pedido ML 20001234");
    expect(movementSourceLabel("DOCUMENT", "abc")).toBe("NF-e abc");
    expect(movementSourceLabel("FONTE_NOVA", "x")).toBe("FONTE_NOVA x");
    expect(movementSourceLabel(null, null)).toBe("Sem registro externo");
  });

  it("delta com sinal explícito — o sinal É a informação", () => {
    expect(formatQtyDelta(3)).toBe("+3");
    expect(formatQtyDelta(-2)).toBe("−2");
    expect(formatQtyDelta(1234)).toBe("+1.234");
  });
});
