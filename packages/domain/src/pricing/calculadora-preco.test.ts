import { describe, expect, it } from "vitest";

import { calcularPreco, faixaShopee, freteGratisEfetivo } from "./calculadora-preco.js";

describe("calcularPreco — Mercado Livre", () => {
  const ml = { plataforma: "mercado_livre" as const, tarifaFixaMl: 0 };

  it("Clássico 12%: recebido, resultado e margem sobre o preço", () => {
    const r = calcularPreco({ ...ml, preco: 100, custo: 50, tipoAnuncio: "classico", freteMl: 20 });

    expect(r).toMatchObject({ ok: true, comissao: 12, tarifaFixa: 0, frete: 20, recebido: 68, resultado: 18 });
    expect(r.ok && r.margem).toBeCloseTo(0.18);
  });

  it("Premium 17%", () => {
    const r = calcularPreco({ ...ml, preco: 200, custo: 100, tipoAnuncio: "premium", freteMl: 25.5 });

    expect(r).toMatchObject({ ok: true, comissao: 34, frete: 25.5, recebido: 140.5, resultado: 40.5 });
  });

  it("sem cotação: margem indefinida em qualquer preço -- até abaixo de R$ 19 o vendedor paga envio", () => {
    expect(calcularPreco({ ...ml, preco: 18.9, custo: 5, tipoAnuncio: "classico", freteMl: null }).ok).toBe(false);
    expect(calcularPreco({ ...ml, preco: 50, custo: 5, tipoAnuncio: "classico", freteMl: null }).ok).toBe(false);
  });

  it("sem a tarifa fixa cotada, também não há margem", () => {
    const r = calcularPreco({ plataforma: "mercado_livre", preco: 50, custo: 5, tipoAnuncio: "classico", freteMl: 8.25, tarifaFixaMl: null });

    expect(r.ok).toBe(false);
  });

  it("abaixo de R$ 79 sem frete grátis: só o custo de envio por unidade (Coleta, R$ 50, medido em 07/10)", () => {
    const r = calcularPreco({ ...ml, preco: 50, custo: 20, tipoAnuncio: "classico", freteMl: 8.25, ofereceFreteGratis: false });

    // 50 − 6 − 8,25 = 35,75; − 20 = 15,75
    expect(r).toMatchObject({ ok: true, comissao: 6, frete: 8.25, recebido: 35.75, resultado: 15.75 });
    expect(r.ok && r.linhas.find((l) => l.rotulo === "Frete")?.detalhe).toMatch(/sem frete grátis/);
  });

  it("abaixo de R$ 79 oferecendo frete grátis: o frete inteiro da cotação", () => {
    const r = calcularPreco({ ...ml, preco: 50, custo: 20, tipoAnuncio: "classico", freteMl: 13.85, ofereceFreteGratis: true });

    expect(r).toMatchObject({ ok: true, frete: 13.85, resultado: 10.15 });
    expect(r.ok && r.linhas.find((l) => l.rotulo === "Frete")?.detalhe).toMatch(/oferecido por você/);
  });

  it("a partir de R$ 79 o frete grátis é obrigatório, mesmo que a escolha diga que não", () => {
    const r = calcularPreco({ ...ml, preco: 79, custo: 20, tipoAnuncio: "classico", freteMl: 18.15, ofereceFreteGratis: false });

    expect(r.ok && r.linhas.find((l) => l.rotulo === "Frete")?.detalhe).toMatch(/obrigatório/);
    expect(freteGratisEfetivo(79, false)).toBe(true);
    expect(freteGratisEfetivo(78.99, false)).toBe(false);
    expect(freteGratisEfetivo(78.99, true)).toBe(true);
  });

  it("tarifa fixa do Flex abaixo de R$ 79 entra antes do 'você recebe' e vira linha própria", () => {
    const r = calcularPreco({
      plataforma: "mercado_livre",
      preco: 50,
      custo: 20,
      tipoAnuncio: "classico",
      freteMl: 0,
      tarifaFixaMl: 7.75,
    });

    // 50 − 6 − 7,75 − 0 = 36,25
    expect(r).toMatchObject({ ok: true, tarifaFixa: 7.75, recebido: 36.25, resultado: 16.25 });
    expect(r.ok && r.linhas.map((l) => l.rotulo)).toEqual(["Comissão", "Tarifa fixa", "Frete"]);
  });

  it("sem tarifa fixa, a linha não aparece", () => {
    const r = calcularPreco({ ...ml, preco: 120, custo: 50, tipoAnuncio: "classico", freteMl: 18.15 });

    expect(r.ok && r.linhas.map((l) => l.rotulo)).toEqual(["Comissão", "Frete"]);
  });

  it("margem negativa aparece como negativa", () => {
    const r = calcularPreco({ ...ml, preco: 50, custo: 45, tipoAnuncio: "premium", freteMl: 20 });

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
