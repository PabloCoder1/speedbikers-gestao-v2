import { describe, expect, it } from "vitest";

import { checarAnuncio, idadeRelativa, type FatosDoAnuncio } from "./checagem";

const agora = new Date("2026-09-16T12:00:00Z");

const saudavel: FatosDoAnuncio = {
  itemId: "MLB1",
  status: "active",
  disponivel: 12,
  skuId: "sku-1",
  sku: "SKU-1",
  syncedAt: "2026-09-16T10:00:00Z",
  agora,
  full: 3,
  resumo: { unidades: 8, visitas: 250, diasObservados: 1 },
  janelaDias: 30,
};

const tomDe = (fatos: FatosDoAnuncio, chave: string) => checarAnuncio(fatos).find((item) => item.chave === chave)?.tom;

describe("checarAnuncio", () => {
  it("anúncio em ordem: todas as linhas ok", () => {
    const itens = checarAnuncio(saudavel);

    expect(itens).toHaveLength(7);
    expect(itens.every((item) => item.tom === "ok")).toBe(true);
  });

  it("disponível zero é PERIGO medido, não ausência", () => {
    expect(tomDe({ ...saudavel, disponivel: 0 }, "estoque")).toBe("perigo");
  });

  it("sem snapshot de Full é neutro, e Full zero é atenção — ausência não é zero", () => {
    expect(tomDe({ ...saudavel, full: null }, "full")).toBe("neutro");
    expect(tomDe({ ...saudavel, full: 0 }, "full")).toBe("atencao");
  });

  it("Full não lido e resumo ausente somem em vez de virar chute", () => {
    const chaves = checarAnuncio({ ...saudavel, full: undefined, resumo: null }).map((item) => item.chave);

    expect(chaves).not.toContain("full");
    expect(chaves).not.toContain("visitas");
    expect(chaves).not.toContain("venda");
  });

  it("sem coleta de visitas é neutro, nunca 'zero visita'", () => {
    const resumo = { unidades: 0, visitas: 0, diasObservados: 0 };

    expect(tomDe({ ...saudavel, resumo }, "visitas")).toBe("neutro");
    expect(checarAnuncio({ ...saudavel, resumo }).find((item) => item.chave === "venda")?.titulo).toBe(
      "Sem venda no período",
    );
  });

  it("visita sem venda aponta para o preço", () => {
    const venda = checarAnuncio({ ...saudavel, resumo: { unidades: 0, visitas: 90, diasObservados: 4 } }).find(
      (item) => item.chave === "venda",
    );

    expect(venda?.titulo).toBe("Recebe visita e não vende");
    expect(venda?.acao?.href).toBe("/anuncios/MLB1?aba=preco");
  });

  it("leitura com mais de 12 h é antiga", () => {
    expect(tomDe({ ...saudavel, syncedAt: "2026-09-15T20:00:00Z" }, "sync")).toBe("atencao");
  });

  it("o que pede trabalho vem primeiro", () => {
    const itens = checarAnuncio({ ...saudavel, disponivel: 0, skuId: null, sku: null });

    expect(itens[0]?.chave).toBe("estoque");
    expect(itens[1]?.chave).toBe("vinculo");
  });
});

describe("idadeRelativa", () => {
  it("minutos, horas e dias", () => {
    expect(idadeRelativa("2026-09-16T11:30:00Z", agora)).toBe("há 30 min");
    expect(idadeRelativa("2026-09-16T09:00:00Z", agora)).toBe("há 3 h");
    expect(idadeRelativa("2026-09-13T12:00:00Z", agora)).toBe("há 3 dias");
  });
});
