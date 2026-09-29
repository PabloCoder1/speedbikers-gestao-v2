import { describe, expect, it } from "vitest";

import { lerCampanhas, periodo, precoDaCampanha, quemPaga, rotuloDoTipo, separarCampanhas } from "./campanhas";

// Na forma que o worker grava (`promotionOffers`), a partir de entradas reais
// da sonda de 29/09 (D-420).
const GRAVADO = [
  {
    type: "SMART",
    status: "candidate",
    id: "P-MLB17937078",
    name: "Impulsione suas vendas",
    start_date: null,
    finish_date: null,
    price: 232.7,
    original_price: 273.42,
    suggested_price: null,
    min_price: null,
    max_price: null,
    meli_percentage: 0.96,
    seller_percentage: 14.04,
    fixed_percentage: null,
  },
  {
    type: "PRICE_DISCOUNT",
    status: "candidate",
    id: null,
    name: null,
    start_date: null,
    finish_date: null,
    price: null,
    original_price: 149.9,
    suggested_price: 94.89,
    min_price: 37.96,
    max_price: 142.4,
    meli_percentage: null,
    seller_percentage: null,
    fixed_percentage: null,
  },
  {
    type: "SELLER_COUPON_CAMPAIGN",
    status: "candidate",
    id: "C-MLB5174575",
    name: "Cupom para carrinhos abandonados",
    start_date: "2026-08-20T00:00:00",
    finish_date: "2026-10-19T23:59:59",
    price: null,
    original_price: 149.9,
    suggested_price: null,
    min_price: null,
    max_price: null,
    meli_percentage: null,
    seller_percentage: null,
    fixed_percentage: 10,
  },
  {
    type: "DEAL",
    status: "started",
    id: "P-MLB18061082",
    name: "10.10",
    start_date: "2026-09-28T00:00:00-03:00",
    finish_date: "2026-10-13T00:00:00-03:00",
    price: 18.9,
    original_price: 19.9,
    suggested_price: null,
    min_price: null,
    max_price: null,
    meli_percentage: null,
    seller_percentage: null,
    fixed_percentage: null,
  },
];

describe("campanhas do anúncio (D-420)", () => {
  it("lê a coluna sem confiar nela: nulo é não lido, e entrada estranha fica de fora", () => {
    expect(lerCampanhas(null)).toBeNull();
    expect(lerCampanhas({ type: "DEAL" })).toBeNull();
    expect(lerCampanhas([])).toEqual([]);
    expect(lerCampanhas([{ status: "candidate" }, { type: "DEAL", status: "finished" }, 7])).toEqual([]);
    expect(lerCampanhas(GRAVADO)).toHaveLength(4);
  });

  it("separa a no ar das candidatas, e cada tipo tem nome — o desconhecido fica com o código", () => {
    const { noAr, candidatas } = separarCampanhas(lerCampanhas(GRAVADO) ?? []);

    expect(noAr.map((c) => c.type)).toEqual(["DEAL"]);
    expect(candidatas.map((c) => rotuloDoTipo(c.type))).toEqual([
      "Co-participada",
      "Desconto no preço",
      "Cupom do vendedor",
    ]);
    expect(rotuloDoTipo("NOVO_TIPO")).toBe("NOVO_TIPO");
  });

  it("o período é o dia de Brasília do texto, com ou sem fuso — nunca o dia do servidor", () => {
    const [, , cupom, noAr] = lerCampanhas(GRAVADO) ?? [];

    expect(cupom === undefined ? null : periodo(cupom)).toBe("20/08/2026 a 19/10/2026");
    expect(noAr === undefined ? null : periodo(noAr)).toBe("28/09/2026 a 13/10/2026");
  });

  it("preço: o proposto pela campanha, ou o sugerido com a faixa; quem paga, quando se sabe", () => {
    const [smart, desconto, cupom, noAr] = lerCampanhas(GRAVADO) ?? [];

    expect(smart === undefined ? null : precoDaCampanha(smart)).toMatch(/232,70/);
    expect(desconto === undefined ? null : precoDaCampanha(desconto)).toMatch(/^sugerido R\$\s94,89 \(de R\$\s37,96 a R\$\s142,40\)$/);
    expect(cupom === undefined ? null : precoDaCampanha(cupom)).toBeNull();
    expect(noAr === undefined ? null : precoDaCampanha(noAr)).toMatch(/18,90/);

    expect(smart === undefined ? null : quemPaga(smart)).toBe("Mercado Livre 0,96% · você 14,04%");
    expect(cupom === undefined ? null : quemPaga(cupom)).toBe("cupom de 10%");
    expect(desconto === undefined ? null : quemPaga(desconto)).toBeNull();
  });
});
