import { describe, expect, it } from "vitest";

import { fingerprintDaDescricao, fotoDoItem, linkDoItem, listingItemSchema, medidasDeclaradas } from "./listing-schema.js";

const ITEM = {
  id: "MLB5021016752",
  title: "Bau Traseiro Plástico Abs 45l",
  status: "active",
  price: 329.9,
  currency_id: "BRL",
  available_quantity: 8,
};

describe("foto e link do anúncio (/anuncios, 20260918150000)", () => {
  it("item sem foto nem link continua válido — os campos são opcionais", () => {
    const item = listingItemSchema.parse(ITEM);

    expect(fotoDoItem(item)).toBeNull();
    expect(linkDoItem(item)).toBeNull();
  });

  it("prefere secure_thumbnail e usa thumbnail http como reserva, promovido a https", () => {
    expect(
      fotoDoItem({
        secure_thumbnail: "https://http2.mlstatic.com/D_123-I.jpg",
        thumbnail: "http://http2.mlstatic.com/D_999-I.jpg",
      }),
    ).toBe("https://http2.mlstatic.com/D_123-I.jpg");
    expect(fotoDoItem({ secure_thumbnail: null, thumbnail: "http://http2.mlstatic.com/D_999-I.jpg" })).toBe(
      "https://http2.mlstatic.com/D_999-I.jpg",
    );
  });

  it("endereço fora do domínio esperado, ou que não é URL, vira nulo", () => {
    expect(fotoDoItem({ secure_thumbnail: "https://evil.example/x.jpg" })).toBeNull();
    // "mlstatic.com" no meio do nome não basta: o host tem de TERMINAR nele.
    expect(fotoDoItem({ secure_thumbnail: "https://mlstatic.com.evil.example/x.jpg" })).toBeNull();
    expect(linkDoItem({ permalink: "javascript:alert(1)" })).toBeNull();
    expect(linkDoItem({ permalink: "não é url" })).toBeNull();
  });

  it("link do anúncio no domínio do Mercado Livre passa", () => {
    expect(linkDoItem({ permalink: "https://produto.mercadolivre.com.br/MLB-5021016752-bau-traseiro" })).toBe(
      "https://produto.mercadolivre.com.br/MLB-5021016752-bau-traseiro",
    );
  });
});

describe("fingerprintDaDescricao (D-390)", () => {
  it("mesmo texto produz o mesmo hash, texto diferente produz hash diferente", () => {
    const a = fingerprintDaDescricao("Descrição original do anúncio.");
    const b = fingerprintDaDescricao("Descrição original do anúncio.");
    const c = fingerprintDaDescricao("Descrição editada do anúncio.");

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("null (sem descrição própria) não vira hash de string vazia", () => {
    expect(fingerprintDaDescricao(null)).toBeNull();
    expect(fingerprintDaDescricao(null)).not.toBe(fingerprintDaDescricao(""));
  });

  it("nunca grava o texto em si — só o hash", () => {
    const hash = fingerprintDaDescricao("Texto que não pode aparecer no evento.");

    expect(hash).not.toContain("Texto que não pode aparecer no evento.");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("medidasDeclaradas (D-405, a sonda do anúncio)", () => {
  it("lê shipping.dimensions quando vem como texto", () => {
    const item = listingItemSchema.parse({ ...ITEM, shipping: { mode: "me2", dimensions: "10x20x30,500" } });

    expect(medidasDeclaradas(item)).toBe("10x20x30,500");
  });

  it("sem shipping, com dimensions nulo, vazio ou fora de forma: nulo — e o anúncio continua válido", () => {
    for (const shipping of [undefined, null, "me2", { mode: "me2" }, { dimensions: null }, { dimensions: "  " }, { dimensions: 7 }]) {
      const item = listingItemSchema.parse({ ...ITEM, shipping });

      expect(medidasDeclaradas(item)).toBeNull();
    }
  });
});
