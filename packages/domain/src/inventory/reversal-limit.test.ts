import { describe, expect, it } from "vitest";

import {
  cancellationKeyOf,
  excessReversed,
  remainingToReverse,
  returnKeyOf,
  revertedSaleKeyOf,
  reversedQuantity,
} from "./reversal-limit.js";
import type { RecordedReversal } from "./reversal-limit.js";

const VENDA = "venda:2000018212899604:0";

describe("revertedSaleKeyOf — a venda que uma reversão reverteu", () => {
  it("cancelamento e devolução, PRODUTO e KIT", () => {
    expect(revertedSaleKeyOf(cancellationKeyOf(VENDA))).toBe(VENDA);
    expect(revertedSaleKeyOf(returnKeyOf("5570995770", VENDA))).toBe(VENDA);
    expect(revertedSaleKeyOf("devolucao:5570995770:venda:2000018212899604:0:sku-a")).toBe("venda:2000018212899604:0:sku-a");
    expect(revertedSaleKeyOf("cancelamento:venda:2000018212899604:0:sku-a")).toBe("venda:2000018212899604:0:sku-a");
  });

  it.each([
    "estorno:venda:1:0",
    "cancelamento:",
    "cancelamento:outra:1:0",
    "devolucao:5570995770",
    "devolucao::venda:1:0",
    "devolucao:5570995770:venda:",
    "venda:1:0",
  ])("chave fora do formato LANÇA (%s) — não vira 'venda não revertida'", (chave) => {
    expect(() => revertedSaleKeyOf(chave)).toThrow(/fora do formato/);
  });
});

describe("o limite das reversões de uma venda", () => {
  const DEVOLUCAO: RecordedReversal = { idempotencyKey: returnKeyOf("5570995770", VENDA), quantity: 1 };
  const CANCELAMENTO: RecordedReversal = { idempotencyKey: cancellationKeyOf(VENDA), quantity: 1 };
  const DE_OUTRA_VENDA: RecordedReversal[] = [
    // Mesmo pedido, componente de KIT: outra linha de venda.
    { idempotencyKey: "cancelamento:venda:2000018212899604:0:sku-a", quantity: 5 },
    // Pedido cujo id começa com o mesmo prefixo.
    { idempotencyKey: "devolucao:1:venda:20000182128996040:0", quantity: 5 },
  ];

  it("soma as duas causas, só da venda pedida", () => {
    expect(reversedQuantity(VENDA, [DEVOLUCAO, CANCELAMENTO, ...DE_OUTRA_VENDA])).toBe(2);
  });

  it("o que resta para o cancelamento depois da devolução entregue da venda inteira: zero", () => {
    expect(remainingToReverse({ idempotencyKey: VENDA, qtyDelta: -1 }, [DEVOLUCAO, ...DE_OUTRA_VENDA], cancellationKeyOf(VENDA))).toBe(0);
  });

  it("a própria reversão fica fora da soma: reprocessar calcula o mesmo movimento", () => {
    expect(remainingToReverse({ idempotencyKey: VENDA, qtyDelta: -1 }, [CANCELAMENTO], cancellationKeyOf(VENDA))).toBe(1);
  });

  it("devolução parcial: resta a diferença, nunca negativo", () => {
    const parcial: RecordedReversal = { idempotencyKey: returnKeyOf("1", VENDA), quantity: 1 };

    expect(remainingToReverse({ idempotencyKey: VENDA, qtyDelta: -3 }, [parcial], cancellationKeyOf(VENDA))).toBe(2);
    expect(remainingToReverse({ idempotencyKey: VENDA, qtyDelta: -1 }, [parcial, DEVOLUCAO], cancellationKeyOf(VENDA))).toBe(0);
  });

  it("excesso: só o que passou da quantidade vendida (o legado com cancelamento E devolução)", () => {
    expect(excessReversed({ idempotencyKey: VENDA, qtyDelta: -1 }, [DEVOLUCAO, CANCELAMENTO])).toBe(1);
    expect(excessReversed({ idempotencyKey: VENDA, qtyDelta: -1 }, [DEVOLUCAO])).toBe(0);
    expect(excessReversed({ idempotencyKey: VENDA, qtyDelta: -2 }, [DEVOLUCAO, CANCELAMENTO])).toBe(0);
  });

  it("soma em três casas: 0,1 + 0,2 não sobra resto de ponto flutuante", () => {
    const fracoes: RecordedReversal[] = [
      { idempotencyKey: returnKeyOf("1", VENDA), quantity: 0.1 },
      { idempotencyKey: returnKeyOf("2", VENDA), quantity: 0.2 },
    ];

    expect(remainingToReverse({ idempotencyKey: VENDA, qtyDelta: -0.3 }, fracoes, cancellationKeyOf(VENDA))).toBe(0);
  });
});
