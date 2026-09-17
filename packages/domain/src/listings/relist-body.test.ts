import { describe, expect, it } from "vitest";

import type { RelistParentForBody } from "./relist-body.js";
import { buildRelistBody, hasRelistStock } from "./relist-body.js";

/** O pai do incidente (MLB1476804187), reduzido: preço de raiz e variações com preço próprio. */
function parentWithVariations(overrides: Partial<RelistParentForBody> = {}): RelistParentForBody {
  return {
    price: 114.9,
    available_quantity: 17_135,
    listing_type_id: "gold_special",
    variations: [
      { id: 180_214_523_001, price: 114.9, available_quantity: 1_200 },
      { id: "180214523002", price: 129.9, available_quantity: 35 },
    ],
    ...overrides,
  };
}

describe("buildRelistBody (D-364)", () => {
  it("sem variações: o corpo de sempre — price, quantity e listing_type_id na raiz", () => {
    const body = buildRelistBody({ price: 199.9, available_quantity: 5, listing_type_id: "gold_special", variations: [] });

    expect(body).toEqual({ price: 199.9, quantity: 5, listing_type_id: "gold_special" });
  });

  it("com variações: listing_type_id + variations, cada uma com o PRÓPRIO preço e o id numérico — nada de price/quantity na raiz", () => {
    const body = buildRelistBody(parentWithVariations());

    expect(body).toEqual({
      listing_type_id: "gold_special",
      variations: [
        { id: 180_214_523_001, price: 114.9, quantity: 1_200 },
        { id: 180_214_523_002, price: 129.9, quantity: 35 },
      ],
    });
    // O 400 do incidente: o corpo sem variação para um pai com variações.
    expect(body).not.toHaveProperty("price");
    expect(body).not.toHaveProperty("quantity");
    expect(body !== null && "variations" in body ? typeof body.variations[1]?.id : null).toBe("number");
  });

  it("variação sem estoque fica FORA do corpo — a doc manda só as que se quer manter", () => {
    const body = buildRelistBody(
      parentWithVariations({
        variations: [
          { id: 1, price: 10, available_quantity: 0 },
          { id: 2, price: 20, available_quantity: 3 },
        ],
      }),
    );

    expect(body).toEqual({ listing_type_id: "gold_special", variations: [{ id: 2, price: 20, quantity: 3 }] });
  });

  it("sem estoque não há corpo: variações todas zeradas, ou item sem variação zerado — o POST não pode sair", () => {
    expect(
      buildRelistBody(
        parentWithVariations({
          variations: [
            { id: 1, price: 10, available_quantity: 0 },
            { id: 2, price: 20, available_quantity: 0 },
          ],
        }),
      ),
    ).toBeNull();

    expect(buildRelistBody({ price: 10, available_quantity: 0, listing_type_id: "free", variations: [] })).toBeNull();
  });

  it("estoque só conta inteiro maior que zero", () => {
    expect(hasRelistStock(1)).toBe(true);
    for (const semEstoque of [0, -1, 1.5, Number.NaN]) {
      expect(hasRelistStock(semEstoque)).toBe(false);
    }
  });
});
