import { describe, expect, it } from "vitest";

import { anuncioDaMudanca, type LinhaDeMudancaDePreco } from "./mudanca-de-preco";

const DO_ML: LinhaDeMudancaDePreco = {
  marketplace: "mercado_livre",
  item_id: "MLB800000001",
  status: "active",
  shopee_shop_id: null,
  model_name: null,
  account_label: "Loja E2E",
};

const DA_SHOPEE: LinhaDeMudancaDePreco = {
  marketplace: "shopee",
  item_id: "990777001",
  status: "UNLIST",
  shopee_shop_id: "aaaa-bbbb",
  model_name: "Preta",
  account_label: "Loja Shopee Real",
};

describe("anuncioDaMudanca (D-640, C-81)", () => {
  it("a linha do ML fica como sempre: o detalhe do anúncio, o status do ML e a conta", () => {
    expect(anuncioDaMudanca(DO_ML)).toEqual({
      href: "/anuncios/MLB800000001",
      status: "Ativo",
      variacao: null,
      origem: "Loja E2E",
    });
  });

  it("a da Shopee vai para a lista da loja buscada pelo item, nunca para /anuncios/<id>", () => {
    const anuncio = anuncioDaMudanca(DA_SHOPEE);

    expect(anuncio.href).toBe("/anuncios/shopee?loja=aaaa-bbbb&q=990777001");
    expect(anuncio.status).toBe("Pausado");
    expect(anuncio.variacao).toBe("Preta");
    expect(anuncio.origem).toBe("Shopee · Loja Shopee Real");
  });

  it("sem a loja não há destino seguro; sem variação nem status, nada inventado", () => {
    expect(anuncioDaMudanca({ ...DA_SHOPEE, shopee_shop_id: null }).href).toBeNull();
    expect(anuncioDaMudanca({ ...DA_SHOPEE, model_name: "  " }).variacao).toBeNull();
    expect(anuncioDaMudanca({ ...DA_SHOPEE, status: null }).status).toBeNull();
    // O status desconhecido da Shopee sai como veio, como em /anuncios/shopee.
    expect(anuncioDaMudanca({ ...DA_SHOPEE, status: "DELETED" }).status).toBe("DELETED");
  });
});
