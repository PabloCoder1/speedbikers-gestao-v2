import { describe, expect, it } from "vitest";

import {
  classifyListingRef,
  isMercadoLivreStore,
  storeLabel,
  storeSlug,
} from "./listing-ref.js";

/**
 * Os valores usados aqui são reais, copiados da exportação de 2026-08-20.
 * Teste de parser com dado inventado passa e não prova nada.
 */

describe("classifyListingRef", () => {
  it("anúncio com variação numérica real", () => {
    expect(classifyListingRef("MLB1722724235", "205704879161")).toEqual({
      kind: "ITEM",
      itemId: "MLB1722724235",
      variationId: "205704879161",
    });
  });

  it("anúncio sem variação: o ERP repete o id e nós normalizamos para null", () => {
    // 3.579 dos vínculos reais têm esta forma. Guardar o id repetido como
    // variação criaria uma variação que não existe no Mercado Livre.
    expect(classifyListingRef("MLB1722724235", "MLB1722724235")).toEqual({
      kind: "ITEM",
      itemId: "MLB1722724235",
      variationId: null,
    });
  });

  it("variação ausente também vira null", () => {
    expect(classifyListingRef("MLB1722724235", null)).toEqual({
      kind: "ITEM",
      itemId: "MLB1722724235",
      variationId: null,
    });
  });

  it("célula com traço conta como vazia", () => {
    expect(classifyListingRef("MLB1722724235", "-")).toEqual({
      kind: "ITEM",
      itemId: "MLB1722724235",
      variationId: null,
    });
  });

  it("MLBU é user product, não anúncio", () => {
    expect(classifyListingRef("MLBU4818089142", "MLBU4818089142")).toEqual({
      kind: "USER_PRODUCT",
      userProductId: "MLBU4818089142",
    });
  });

  it("MLBU não é confundido com MLB, apesar do prefixo comum", () => {
    // A armadilha: /^MLB\d+$/ não casa com MLBU porque o U não é dígito, mas
    // uma verificação por startsWith('MLB') casaria. A ordem dos testes e o
    // regex ancorado são o que garante isso.
    const ref = classifyListingRef("MLBU4818089142", "MLBU4818089142");

    expect(ref.kind).toBe("USER_PRODUCT");
  });

  it("recusa identificador não reconhecido", () => {
    expect(classifyListingRef("XYZ123", "1").kind).toBe("INVALID");
  });

  it("recusa anúncio ausente", () => {
    expect(classifyListingRef(null, "205704879161").kind).toBe("INVALID");
  });

  it("recusa variação que não é numérica nem repetição do anúncio", () => {
    const ref = classifyListingRef("MLB1722724235", "MLB9999999999");

    expect(ref.kind).toBe("INVALID");
  });
});

describe("filtro de canal (D-037)", () => {
  it.each([
    "mercado-ML- Speedbikers (loja 1)",
    "mercado-ML- Speedbikers (loja 2)",
    "mercado-ML - SbMotos",
    "mercado-ML - GMR",
  ])("aceita %s", (store) => {
    expect(isMercadoLivreStore(store)).toBe(true);
  });

  it.each(["shopee-Speedbikers", "shopee-Sbmotos", "kwai-SpeedBikers", "temu-Speed Bikers", "tiktok-Speed Bikers"])(
    "descarta %s",
    (store) => {
      expect(isMercadoLivreStore(store)).toBe(false);
    },
  );

  it("descarta loja vazia", () => {
    expect(isMercadoLivreStore(null)).toBe(false);
  });
});

describe("rótulo e slug da loja", () => {
  it.each([
    ["mercado-ML- Speedbikers (loja 1)", "ML- Speedbikers (loja 1)", "ml-speedbikers-loja-1"],
    ["mercado-ML - SbMotos", "ML - SbMotos", "ml-sbmotos"],
    ["mercado-ML - GMR", "ML - GMR", "ml-gmr"],
  ])("%s", (raw, label, slug) => {
    expect(storeLabel(raw)).toBe(label);
    expect(storeSlug(raw)).toBe(slug);
  });

  it("slug respeita o charset exigido pelo Cloud Tasks", () => {
    // Precisa casar com a constraint de ml_accounts.slug (D-036).
    const slug = storeSlug("mercado-ML- Speedbikers (loja 1)");

    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/);
  });

  it("slug nunca termina em hífen, mesmo com corte de tamanho", () => {
    const slug = storeSlug(`mercado-ML- ${"x".repeat(60)} (loja)`);

    expect(slug).not.toMatch(/-$/);
    expect((slug ?? "").length).toBeLessThanOrEqual(40);
  });
});
