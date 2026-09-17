import { describe, expect, it } from "vitest";

import {
  cancellationKeyOf,
  excessReversalShares,
  excessReversed,
  remainingToReverse,
  returnKeyOf,
  revertedSaleKeyOf,
  reversedQuantity,
} from "./reversal-limit.js";
import type { RecordedReversal, TimedRecordedReversal } from "./reversal-limit.js";

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

describe("excessReversalShares — o excesso é das reversões mais recentes (D-351 §12)", () => {
  const CANCELAMENTO = cancellationKeyOf(VENDA);
  const DEVOLUCAO_1 = returnKeyOf("5570000001", VENDA);
  const DEVOLUCAO_2 = returnKeyOf("5570000002", VENDA);
  const em = (hora: string) => new Date(`2026-09-15T${hora}:00.000Z`);
  const partes = (shares: ReturnType<typeof excessReversalShares>) =>
    shares.map((share) => [share.reversal.idempotencyKey, share.quantity]);

  it("R <= V: nada passou", () => {
    const reversoes: TimedRecordedReversal[] = [{ idempotencyKey: CANCELAMENTO, quantity: 1, occurredAt: em("10:00") }];

    expect(excessReversalShares({ idempotencyKey: VENDA, qtyDelta: -1 }, reversoes)).toEqual([]);
    expect(excessReversalShares({ idempotencyKey: VENDA, qtyDelta: -2 }, [...reversoes, { idempotencyKey: DEVOLUCAO_1, quantity: 1, occurredAt: em("11:00") }])).toEqual([]);
  });

  it("devolução e depois cancelamento: o excesso é do cancelamento -- a unidade já tinha voltado na devolução", () => {
    const reversoes: TimedRecordedReversal[] = [
      { idempotencyKey: CANCELAMENTO, quantity: 1, occurredAt: em("12:58") },
      { idempotencyKey: DEVOLUCAO_1, quantity: 1, occurredAt: em("00:12") },
    ];

    expect(partes(excessReversalShares({ idempotencyKey: VENDA, qtyDelta: -1 }, reversoes))).toEqual([[CANCELAMENTO, 1]]);
  });

  it("cancelamento e depois devolução (2000017914279632): o excesso é da devolução", () => {
    const reversoes: TimedRecordedReversal[] = [
      { idempotencyKey: CANCELAMENTO, quantity: 1, occurredAt: em("20:39") },
      { idempotencyKey: DEVOLUCAO_1, quantity: 1, occurredAt: em("20:40") },
    ];

    expect(partes(excessReversalShares({ idempotencyKey: VENDA, qtyDelta: -1 }, reversoes))).toEqual([[DEVOLUCAO_1, 1]]);
  });

  it("excesso maior que a reversão mais recente: continua na anterior, da mais recente para a mais antiga", () => {
    const reversoes: TimedRecordedReversal[] = [
      { idempotencyKey: CANCELAMENTO, quantity: 2, occurredAt: em("08:00") },
      { idempotencyKey: DEVOLUCAO_1, quantity: 1, occurredAt: em("09:00") },
      { idempotencyKey: DEVOLUCAO_2, quantity: 1, occurredAt: em("10:00") },
    ];

    expect(partes(excessReversalShares({ idempotencyKey: VENDA, qtyDelta: -2 }, reversoes))).toEqual([
      [DEVOLUCAO_2, 1],
      [DEVOLUCAO_1, 1],
    ]);
    // Parte de uma reversão: 3 vendidas, cancelamento de 2 e devolução de 2 -> passou 1, da devolução.
    expect(
      partes(
        excessReversalShares({ idempotencyKey: VENDA, qtyDelta: -3 }, [
          { idempotencyKey: CANCELAMENTO, quantity: 2, occurredAt: em("08:00") },
          { idempotencyKey: DEVOLUCAO_1, quantity: 2, occurredAt: em("09:00") },
        ]),
      ),
    ).toEqual([[DEVOLUCAO_1, 1]]);
  });

  it("empate no instante: a chave maior na ordem de código fica com o excesso -- o worker e a F3 (collate \"C\") escolhem a mesma", () => {
    const reversoes: TimedRecordedReversal[] = [
      { idempotencyKey: CANCELAMENTO, quantity: 1, occurredAt: em("10:00") },
      { idempotencyKey: DEVOLUCAO_1, quantity: 1, occurredAt: em("10:00") },
    ];

    expect(partes(excessReversalShares({ idempotencyKey: VENDA, qtyDelta: -1 }, reversoes))).toEqual([[DEVOLUCAO_1, 1]]);
    expect(partes(excessReversalShares({ idempotencyKey: VENDA, qtyDelta: -1 }, [...reversoes].reverse()))).toEqual([[DEVOLUCAO_1, 1]]);
  });

  it("mesmo segundo, milissegundos diferentes: o excesso é da de milissegundo maior, mesmo com a chave menor -- o instante vai ao milissegundo, como o worker grava e a F3 compara (date_trunc('milliseconds'))", () => {
    // A ordem da chave ("devolucao" > "cancelamento") é a oposta à do instante: comparando ao
    // segundo, o empate daria o excesso à devolução.
    const reversoes: TimedRecordedReversal[] = [
      { idempotencyKey: CANCELAMENTO, quantity: 1, occurredAt: new Date("2026-09-15T10:00:00.900Z") },
      { idempotencyKey: DEVOLUCAO_1, quantity: 1, occurredAt: new Date("2026-09-15T10:00:00.100Z") },
    ];

    expect(partes(excessReversalShares({ idempotencyKey: VENDA, qtyDelta: -1 }, reversoes))).toEqual([[CANCELAMENTO, 1]]);
    expect(partes(excessReversalShares({ idempotencyKey: VENDA, qtyDelta: -1 }, [...reversoes].reverse()))).toEqual([[CANCELAMENTO, 1]]);
  });

  it("reversões de OUTRA venda do pedido (outro componente) não entram na conta nem ganham parte", () => {
    const reversoes: TimedRecordedReversal[] = [
      { idempotencyKey: CANCELAMENTO, quantity: 1, occurredAt: em("08:00") },
      { idempotencyKey: `cancelamento:${VENDA}:sku-b`, quantity: 1, occurredAt: em("09:00") },
      { idempotencyKey: returnKeyOf("1", `${VENDA}:sku-b`), quantity: 1, occurredAt: em("10:00") },
    ];

    expect(excessReversalShares({ idempotencyKey: VENDA, qtyDelta: -1 }, reversoes)).toEqual([]);
  });

  it("estável para a idempotência: uma reversão nova não muda a parte das anteriores", () => {
    const antes: TimedRecordedReversal[] = [
      { idempotencyKey: DEVOLUCAO_1, quantity: 1, occurredAt: em("08:00") },
      { idempotencyKey: CANCELAMENTO, quantity: 1, occurredAt: em("09:00") },
    ];
    const depois: TimedRecordedReversal[] = [...antes, { idempotencyKey: DEVOLUCAO_2, quantity: 1, occurredAt: em("07:00") }];

    expect(partes(excessReversalShares({ idempotencyKey: VENDA, qtyDelta: -1 }, antes))).toEqual([[CANCELAMENTO, 1]]);
    expect(partes(excessReversalShares({ idempotencyKey: VENDA, qtyDelta: -1 }, depois))).toEqual([
      [CANCELAMENTO, 1],
      [DEVOLUCAO_1, 1],
    ]);
  });
});
