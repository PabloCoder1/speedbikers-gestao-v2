import { describe, expect, it } from "vitest";

import {
  movementSourceHref,
  formatQtyDelta,
  locationKindLabel,
  movementSourceLabel,
  movementTypeLabel,
} from "./movement-labels.js";
import { MOVEMENT_TYPES } from "./movement-filters.js";

describe("vocabulário das movimentações (D-167)", () => {
  it("os 16 tipos aprovados têm rótulo próprio — nenhum aparece cru", () => {
    expect(MOVEMENT_TYPES).toHaveLength(16);

    for (const type of MOVEMENT_TYPES) {
      expect(movementTypeLabel(type)).not.toBe(type);
    }
  });

  it("o estorno de venda anterior à planilha tem rótulo que diz de onde vem (D-351)", () => {
    expect(movementTypeLabel("ESTORNO_PRE_CAPTURA")).toBe("Estorno de venda anterior à planilha (UpSeller)");
  });

  it("a anulação de reversão nomeia as DUAS causas — o dobro da D-351 §12 e o Full da D-352 — e não se confunde com o estorno de venda", () => {
    // Um cancelamento de pedido do Full anulado pela varredura não teve "dobro"
    // nenhum: o rótulo antigo mandava quem audita o saldo procurar a causa errada.
    expect(movementTypeLabel("ESTORNO_REVERSAO_EXCEDENTE")).toBe(
      "Anulação de reversão de venda estornada (em dobro ou do Full)",
    );
    expect(movementTypeLabel("ESTORNO_REVERSAO_EXCEDENTE")).not.toBe(movementTypeLabel("ESTORNO_FULL"));
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

describe("movementSourceHref (lote 3 do pente fino)", () => {
  it("pedido de compra e nota fiscal viram link; o resto fica texto", () => {
    expect(movementSourceHref("PURCHASE_ORDER", "abc")).toBe("/compras/abc");
    expect(movementSourceHref("DOCUMENT", "doc-1")).toBe("/notas-fiscais/doc-1");
    expect(movementSourceHref("ORDER", "2000012345")).toBeNull();
    expect(movementSourceHref("PURCHASE_ORDER", null)).toBeNull();
  });
});
