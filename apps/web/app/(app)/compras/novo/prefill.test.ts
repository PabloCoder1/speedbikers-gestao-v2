import { describe, expect, it } from "vitest";

import { detectOriginMix, parseReplenishmentPrefill } from "./prefill";

const A = "11111111-2222-4333-8444-555555555501";
const B = "11111111-2222-4333-8444-555555555502";

describe("parseReplenishmentPrefill", () => {
  it("lê pares sku:quantidade, um ou vários", () => {
    expect(parseReplenishmentPrefill(`${A}:48`)).toEqual([{ skuId: A, quantity: 48 }]);
    expect(parseReplenishmentPrefill([`${A}:48`, `${B}:7`])).toEqual([
      { skuId: A, quantity: 48 },
      { skuId: B, quantity: 7 },
    ]);
  });

  /**
   * A URL é editável: par corrompido é descartado sem derrubar os demais —
   * erro aqui viraria tela quebrada por um caractere a menos num UUID.
   */
  it("descarta par malformado em silêncio e preserva os válidos", () => {
    expect(
      parseReplenishmentPrefill([`nao-e-uuid:5`, `${A}:abc`, `${A}:0`, `${A}:-3`, `${B}:7`]),
    ).toEqual([{ skuId: B, quantity: 7 }]);
  });

  it("duplicata de SKU fica com a primeira ocorrência", () => {
    expect(parseReplenishmentPrefill([`${A}:48`, `${A}:99`])).toEqual([{ skuId: A, quantity: 48 }]);
  });

  it("vazio e ausente devolvem lista vazia", () => {
    expect(parseReplenishmentPrefill(undefined)).toEqual([]);
    expect(parseReplenishmentPrefill([])).toEqual([]);
  });
});

describe("detectOriginMix", () => {
  it("importado E nacional no mesmo pedido é mistura", () => {
    const mix = detectOriginMix([
      { skuId: A, isImported: true },
      { skuId: B, isImported: false },
    ]);

    expect(mix).toEqual({ imported: 1, national: 1, unknown: 0, mixed: true });
  });

  /**
   * Origem desconhecida NÃO dispara a mistura: `is_imported` nulo (ou item
   * sem SKU catalogado) é ausência de resposta, não resposta — acusar
   * mistura por causa dele seria alarme sobre dado que não existe.
   */
  it("origem desconhecida conta separada e não dispara mistura", () => {
    const mix = detectOriginMix([
      { skuId: A, isImported: true },
      { skuId: null, isImported: null },
      { skuId: B, isImported: null },
    ]);

    expect(mix).toEqual({ imported: 1, national: 0, unknown: 2, mixed: false });
  });

  it("pedido homogêneo não é mistura", () => {
    expect(detectOriginMix([{ skuId: A, isImported: true }]).mixed).toBe(false);
    expect(detectOriginMix([]).mixed).toBe(false);
  });
});
