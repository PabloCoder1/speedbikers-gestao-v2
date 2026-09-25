import { describe, expect, it } from "vitest";

import {
  coberturaDoQuemPaga,
  frasesDoQuemPaga,
  lerQuemPagaFrete,
  mlNoFreteDoVendedor,
  rotuloDaLogistica,
} from "./quem-paga-frete";

/** A resposta de produção de 25/09 (30 dias, o primeiro dia de detalhe), arredondada. */
const RESPOSTA = {
  periodo: { de: "2026-08-26", ate: "2026-09-24" },
  detalhe_desde: "2026-09-24",
  envios_com_frete: 27880,
  envios_com_detalhe: 689,
  frete_cheio: 36621.57,
  frete_do_vendedor: 19773.49,
  vendedor_pagou: 10865.4,
  ml_bancou_vendedor: 8908.09,
  comprador_pagou: 1986.55,
  ml_bancou_comprador: 14953.21,
  frete_gratis_comprador: 542,
  nao_fecham: 35,
  por_logistica: [
    {
      logistica: "fulfillment",
      envios: 442,
      frete_do_vendedor: 13306.67,
      vendedor_pagou: 7266.21,
      ml_bancou_vendedor: 6040.46,
      comprador_pagou: 1231.03,
      ml_bancou_comprador: 9188.53,
      frete_gratis_comprador: 343,
    },
  ],
};

function legivel(texto: string): string {
  return texto.replace(/\s/g, " ");
}

describe("lerQuemPagaFrete (D-412)", () => {
  it("lê a resposta inteira", () => {
    const q = lerQuemPagaFrete(RESPOSTA);

    expect(q?.envios_com_detalhe).toBe(689);
    expect(q?.por_logistica[0]?.logistica).toBe("fulfillment");
  });

  it("sem detalhe no período, as somas são nulas -- não zero; fora do contrato, null", () => {
    const vazio = lerQuemPagaFrete({
      ...RESPOSTA,
      envios_com_detalhe: 0,
      frete_cheio: null,
      frete_do_vendedor: null,
      vendedor_pagou: null,
      ml_bancou_vendedor: null,
      comprador_pagou: null,
      ml_bancou_comprador: null,
      por_logistica: [],
    });

    expect(vazio?.vendedor_pagou).toBeNull();
    expect(mlNoFreteDoVendedor(vazio ?? RESPOSTA)).toBeNull();
    expect(lerQuemPagaFrete({ ...RESPOSTA, por_logistica: null })).toBeNull();
    expect(lerQuemPagaFrete({ ...RESPOSTA, envios_com_frete: "muitos" })).toBeNull();
    expect(lerQuemPagaFrete(null)).toBeNull();
  });
});

describe("as frases e a cobertura (D-412)", () => {
  const q = lerQuemPagaFrete(RESPOSTA);

  if (q === null) throw new Error("fixture fora do contrato");

  it("o Mercado Livre no frete do vendedor e no do comprador, com o frete grátis", () => {
    expect(frasesDoQuemPaga(q).map(legivel)).toEqual([
      "Do frete que cabia ao vendedor (R$ 19.773,49), o Mercado Livre bancou 45,1% (R$ 8.908,09) e o vendedor pagou R$ 10.865,40.",
      "Os compradores pagaram R$ 1.986,55, e o Mercado Livre bancou R$ 14.953,21 do frete deles: 542 dos 689 envios (78,7%) saíram com frete grátis para o comprador.",
    ]);
  });

  it("a cobertura diz quantos envios têm o detalhe, desde quando, e os que não fecham", () => {
    expect(legivel(coberturaDoQuemPaga(q))).toBe(
      "Detalhe em 689 dos 27.880 envios do período (2,5%): os pedidos com o detalhe começam em 24/09/2026, e os anteriores têm só o frete do vendedor. Em 35 deles as partes não fecham com o frete cheio (descontos do comprador que se sobrepõem): as somas são das partes.",
    );
    expect(coberturaDoQuemPaga({ ...q, detalhe_desde: null })).toMatch(/começa a ser gravado/);
  });

  it("a logística como a operação fala; tipo novo aparece cru", () => {
    expect(rotuloDaLogistica("fulfillment")).toBe("Full");
    expect(rotuloDaLogistica("self_service")).toBe("Flex");
    expect(rotuloDaLogistica("tipo_novo")).toBe("tipo_novo");
  });
});
