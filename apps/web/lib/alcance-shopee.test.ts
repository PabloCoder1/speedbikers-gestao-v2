import { describe, expect, it } from "vitest";

import { lojasNaoConcedidas, rotuloDaLojaNoAlcance } from "./alcance-shopee";

describe("rotuloDaLojaNoAlcance", () => {
  it("a loja real pelo nome", () => {
    expect(rotuloDaLojaNoAlcance({ shop_name: "Speedbikers", shop_id: 123, environment: "live" })).toBe("Speedbikers");
  });

  it("a loja de teste leva a marca, para ninguém a confundir com a real", () => {
    expect(rotuloDaLojaNoAlcance({ shop_name: "Loja Shopee E2E", shop_id: 9, environment: "sandbox" })).toBe(
      "Loja Shopee E2E (teste)",
    );
  });

  it("sem nome lido, o número da loja na Shopee", () => {
    expect(rotuloDaLojaNoAlcance({ shop_name: null, shop_id: 456, environment: "live" })).toBe("Loja 456");
  });
});

describe("lojasNaoConcedidas", () => {
  it("tudo concedido: nada a avisar", () => {
    expect(lojasNaoConcedidas(["a", "b"], ["b", "a"])).toEqual([]);
  });

  it("a api velha ignorou o pedido: todas faltam, na ordem pedida", () => {
    expect(lojasNaoConcedidas(["a", "b"], [])).toEqual(["a", "b"]);
  });

  it("concessão a mais (de antes) não esconde a que faltou", () => {
    expect(lojasNaoConcedidas(["a", "b"], ["a", "z"])).toEqual(["b"]);
  });

  it("nada pedido, nada a conferir", () => {
    expect(lojasNaoConcedidas([], ["a"])).toEqual([]);
  });
});
