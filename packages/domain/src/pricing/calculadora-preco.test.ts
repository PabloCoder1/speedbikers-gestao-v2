import { describe, expect, it } from "vitest";

import { calcularPreco, faixaShopee } from "./calculadora-preco.js";

describe("calcularPreco — Mercado Livre", () => {
  it("Clássico 12%: recebido, resultado e margem sobre o preço", () => {
    const r = calcularPreco({ plataforma: "mercado_livre", preco: 100, custo: 50, tipoAnuncio: "classico", freteMl: 20 });

    expect(r).toMatchObject({ ok: true, comissao: 12, frete: 20, recebido: 68, resultado: 18 });
    expect(r.ok && r.margem).toBeCloseTo(0.18);
  });

  it("Premium 17%", () => {
    const r = calcularPreco({ plataforma: "mercado_livre", preco: 200, custo: 100, tipoAnuncio: "premium", freteMl: 25.5 });

    expect(r).toMatchObject({ ok: true, comissao: 34, frete: 25.5, recebido: 140.5, resultado: 40.5 });
  });

  it("abaixo de R$ 19 o frete é do comprador — não pede cotação", () => {
    const r = calcularPreco({ plataforma: "mercado_livre", preco: 18.9, custo: 5, tipoAnuncio: "classico", freteMl: null });

    expect(r).toMatchObject({ ok: true, frete: 0, comissao: 2.27 });
  });

  it("a partir de R$ 19 sem cotação: margem indefinida, nunca frete zero fingido", () => {
    const r = calcularPreco({ plataforma: "mercado_livre", preco: 19, custo: 5, tipoAnuncio: "classico", freteMl: null });

    expect(r.ok).toBe(false);
  });

  it("margem negativa aparece como negativa", () => {
    const r = calcularPreco({ plataforma: "mercado_livre", preco: 50, custo: 45, tipoAnuncio: "premium", freteMl: 20 });

    expect(r.ok && r.resultado).toBe(-23.5);
    expect(r.ok && r.margem).toBeLessThan(0);
  });

  it("recusa preço vazio ou custo negativo", () => {
    expect(calcularPreco({ plataforma: "shopee", preco: 0, custo: 10 }).ok).toBe(false);
    expect(calcularPreco({ plataforma: "shopee", preco: 10, custo: -1 }).ok).toBe(false);
  });
});

describe("calcularPreco — Shopee", () => {
  it("as cinco faixas da tabela, nas fronteiras", () => {
    expect(faixaShopee(79.99)).toMatchObject({ percentual: 0.2, fixo: 4 });
    expect(faixaShopee(80)).toMatchObject({ percentual: 0.14, fixo: 16 });
    expect(faixaShopee(99.99)).toMatchObject({ percentual: 0.14, fixo: 16 });
    expect(faixaShopee(100)).toMatchObject({ percentual: 0.14, fixo: 20 });
    expect(faixaShopee(199.99)).toMatchObject({ percentual: 0.14, fixo: 20 });
    expect(faixaShopee(200)).toMatchObject({ percentual: 0.14, fixo: 26 });
    expect(faixaShopee(500)).toMatchObject({ percentual: 0.14, fixo: 26 });
  });

  it("percentual + fixo (o fixo é o frete), sem medidas", () => {
    const r = calcularPreco({ plataforma: "shopee", preco: 150, custo: 60 });

    expect(r).toMatchObject({ ok: true, comissao: 21, frete: 20, recebido: 109, resultado: 49 });
  });

  it("faixa até R$ 79,99: 20% + R$ 4", () => {
    const r = calcularPreco({ plataforma: "shopee", preco: 50, custo: 20 });

    expect(r).toMatchObject({ ok: true, comissao: 10, frete: 4, recebido: 36, resultado: 16 });
  });
});
