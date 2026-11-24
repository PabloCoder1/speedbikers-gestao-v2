import { describe, expect, it } from "vitest";

import {
  lerPreviaForaDoCatalogo,
  novosAusentes,
  pareceExportacaoParcial,
  sugereMarcar,
  type PreviaForaDoCatalogo,
} from "./produtos-fora-do-catalogo";

const BASE = {
  conhecidos: 100,
  ausentes: 5,
  jaMarcados: 0,
  comSaldo: 2,
  comVinculo: 1,
  voltam: 0,
  amostra: [{ skuId: "s1", sku: "PI150", title: "Painel", saldo: 3, comVinculo: true, foraDesde: null }],
};

function previa(over: Partial<PreviaForaDoCatalogo> = {}): PreviaForaDoCatalogo {
  const lida = lerPreviaForaDoCatalogo({ ...BASE, ...over });

  if (lida === null) throw new Error("prévia de teste inválida");

  return lida;
}

describe("lerPreviaForaDoCatalogo", () => {
  it("lê a prévia do SQL", () => {
    expect(lerPreviaForaDoCatalogo(BASE)).toEqual(BASE);
  });

  it("saldo nulo continua nulo -- sem linha de saldo não é zero", () => {
    const lida = lerPreviaForaDoCatalogo({ ...BASE, amostra: [{ ...BASE.amostra[0], saldo: null }] });

    expect(lida?.amostra[0]?.saldo).toBeNull();
  });

  it.each([
    ["nulo (lote que não é de produtos)", null],
    ["contagem ausente", { ...BASE, ausentes: undefined }],
    ["contagem negativa", { ...BASE, comSaldo: -1 }],
    ["amostra que não é lista", { ...BASE, amostra: {} }],
    ["item da amostra sem sku", { ...BASE, amostra: [{ skuId: "s1", comVinculo: false }] }],
  ])("recusa a prévia inteira quando vem %s", (_nome, raw) => {
    expect(lerPreviaForaDoCatalogo(raw)).toBeNull();
  });
});

describe("padrão da caixa de marcar", () => {
  it("marca por padrão até 10% do catálogo conhecido", () => {
    expect(sugereMarcar(previa({ ausentes: 10 }))).toBe(true);
    expect(pareceExportacaoParcial(previa({ ausentes: 10 }))).toBe(false);
  });

  it("acima de 10% parece exportação parcial e vem desmarcada", () => {
    expect(pareceExportacaoParcial(previa({ ausentes: 11 }))).toBe(true);
    expect(sugereMarcar(previa({ ausentes: 11 }))).toBe(false);
  });

  it("os já marcados por planilha anterior não contam de novo", () => {
    const p = previa({ ausentes: 30, jaMarcados: 25 });

    expect(novosAusentes(p)).toBe(5);
    expect(sugereMarcar(p)).toBe(true);
  });

  it("sem ninguém novo para marcar, não sugere nada", () => {
    expect(sugereMarcar(previa({ ausentes: 3, jaMarcados: 3 }))).toBe(false);
  });

  it("primeira planilha (catálogo conhecido vazio) não é parcial nem marca", () => {
    const p = previa({ conhecidos: 0, ausentes: 0, comSaldo: 0, comVinculo: 0, amostra: [] });

    expect(pareceExportacaoParcial(p)).toBe(false);
    expect(sugereMarcar(p)).toBe(false);
  });
});
