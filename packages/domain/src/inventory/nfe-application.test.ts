import { describe, expect, it } from "vitest";

import { computeNfeApplicationMovements } from "./nfe-application.js";
import type { NfeApplicationDocument, NfeApplicationItem } from "./nfe-application.js";

const OCCURRED_AT = new Date("2026-08-20T09:00:00.000Z");

function baseDocument(overrides: Partial<NfeApplicationDocument> = {}): NfeApplicationDocument {
  return {
    id: "doc-1",
    operationType: "ENTRADA",
    occurredAt: OCCURRED_AT,
    items: [],
    ...overrides,
  };
}

describe("computeNfeApplicationMovements", () => {
  it("ENTRADA soma ao estoque — qtyDelta positivo", () => {
    const items: NfeApplicationItem[] = [{ position: 0, skuId: "sku-parafuso", quantity: 19 }];

    expect(computeNfeApplicationMovements(baseDocument({ items }))).toEqual([
      {
        skuId: "sku-parafuso",
        qtyDelta: 19,
        idempotencyKey: "nfe:doc-1:0",
        occurredAt: OCCURRED_AT,
      },
    ]);
  });

  it("SAIDA subtrai do estoque — qtyDelta negativo", () => {
    const items: NfeApplicationItem[] = [{ position: 0, skuId: "sku-parafuso", quantity: 5 }];

    expect(computeNfeApplicationMovements(baseDocument({ operationType: "SAIDA", items }))).toEqual([
      {
        skuId: "sku-parafuso",
        qtyDelta: -5,
        idempotencyKey: "nfe:doc-1:0",
        occurredAt: OCCURRED_AT,
      },
    ]);
  });

  it("item sem vínculo (skuId nulo) não gera movimento", () => {
    const items: NfeApplicationItem[] = [
      { position: 0, skuId: "sku-parafuso", quantity: 3 },
      { position: 1, skuId: null, quantity: 7 },
    ];

    const result = computeNfeApplicationMovements(baseDocument({ items }));

    expect(result).toHaveLength(1);
    expect(result[0]?.skuId).toBe("sku-parafuso");
  });

  it("múltiplos itens preservam a posição na chave de idempotência", () => {
    const items: NfeApplicationItem[] = [
      { position: 0, skuId: "sku-a", quantity: 1 },
      { position: 1, skuId: "sku-b", quantity: 2 },
    ];

    const result = computeNfeApplicationMovements(baseDocument({ items }));

    expect(result.map((draft) => draft.idempotencyKey)).toEqual(["nfe:doc-1:0", "nfe:doc-1:1"]);
  });

  it("chave de idempotência é determinística — reprocessar o mesmo documento produz a MESMA chave", () => {
    const items: NfeApplicationItem[] = [{ position: 0, skuId: "sku-parafuso", quantity: 19 }];

    const first = computeNfeApplicationMovements(baseDocument({ items }));
    const second = computeNfeApplicationMovements(baseDocument({ items }));

    expect(first[0]?.idempotencyKey).toBe(second[0]?.idempotencyKey);
  });

  it("documento sem nenhum item vinculado não gera movimento nenhum", () => {
    const items: NfeApplicationItem[] = [{ position: 0, skuId: null, quantity: 19 }];

    expect(computeNfeApplicationMovements(baseDocument({ items }))).toEqual([]);
  });
});
