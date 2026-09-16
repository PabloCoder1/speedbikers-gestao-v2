import { describe, expect, it } from "vitest";

import {
  calcularAlcance,
  governadosPelaRegra,
  lerGruposDoAlcance,
  novosCobertos,
  type EscopoDaRegra,
  type GrupoDoAlcance,
} from "./replenishment-reach";

/*
  O formato de produção no dia de D-361: uma marca grande, uma pequena, uma
  sem nenhum SKU na reposição e o grupo sem marca.
*/
const grupos: GrupoDoAlcance[] = [
  { marca: null, skus: 5, naReposicao: 4, comVenda30d: 2, comRegraSku: 0, comRegraSkuVenda30d: 0 },
  { marca: "NAVETEC", skus: 219, naReposicao: 135, comVenda30d: 117, comRegraSku: 0, comRegraSkuVenda30d: 0 },
  { marca: "OFFRACER", skus: 2393, naReposicao: 1049, comVenda30d: 661, comRegraSku: 3, comRegraSkuVenda30d: 2 },
  { marca: "PROJEÇÃO", skus: 1, naReposicao: 0, comVenda30d: 0, comRegraSku: 0, comRegraSkuVenda30d: 0 },
];

const padrao: EscopoDaRegra = { id: "padrao", marca: null, skuId: null };
const regraNavetec: EscopoDaRegra = { id: "navetec", marca: "NAVETEC", skuId: null };

describe("lerGruposDoAlcance", () => {
  it("lê a linha da RPC, com bigint como número ou como texto (o pg do teste de integração)", () => {
    expect(
      lerGruposDoAlcance([
        {
          supplier_brand: "RT",
          skus: "46",
          skus_na_reposicao: 28,
          skus_com_venda_30d: "21",
          skus_com_regra_sku: 0,
          skus_com_regra_sku_venda_30d: 0,
        },
        { supplier_brand: null, skus: 2, skus_na_reposicao: null, skus_com_venda_30d: -1 },
      ]),
    ).toEqual([
      { marca: "RT", skus: 46, naReposicao: 28, comVenda30d: 21, comRegraSku: 0, comRegraSkuVenda30d: 0 },
      // Nulo, ausente ou negativo vira zero: contagem nunca é negativa.
      { marca: null, skus: 2, naReposicao: 0, comVenda30d: 0, comRegraSku: 0, comRegraSkuVenda30d: 0 },
    ]);
  });
});

describe("calcularAlcance", () => {
  it("sem regra nenhuma, só os SKUs de regra própria ficam cobertos", () => {
    const alcance = calcularAlcance(grupos, []);

    expect(alcance.padraoId).toBeNull();
    expect(alcance.marcas.every((m) => m.governo === "NENHUMA")).toBe(true);
    expect(alcance.totais).toEqual({
      naReposicao: 1188,
      comVenda30d: 780,
      cobertos: 3,
      cobertosComVenda: 2,
      marcasNaReposicao: 2,
      marcasComRegra: 0,
    });
  });

  it("o padrão cobre toda marca sem regra própria, e também o grupo sem marca", () => {
    const alcance = calcularAlcance(grupos, [padrao]);

    expect(alcance.semMarca?.governo).toBe("PADRAO");
    expect(alcance.totais.cobertos).toBe(alcance.totais.naReposicao);
    expect(alcance.totais.cobertosComVenda).toBe(alcance.totais.comVenda30d);
    expect(alcance.totais.marcasComRegra).toBe(0);
  });

  it("regra de marca vence o padrão, e SKU sem marca nunca cai numa marca (D-129)", () => {
    const alcance = calcularAlcance(grupos, [padrao, regraNavetec]);

    expect(alcance.marcas.find((m) => m.marca === "NAVETEC")).toMatchObject({ governo: "MARCA", regraId: "navetec" });
    expect(alcance.marcas.find((m) => m.marca === "OFFRACER")?.governo).toBe("PADRAO");
    expect(alcance.semMarca?.governo).toBe("PADRAO");
    expect(alcance.totais.marcasComRegra).toBe(1);
  });

  it("sem padrão, o grupo sem marca fica descoberto mesmo com todas as marcas configuradas", () => {
    const alcance = calcularAlcance(grupos, [
      regraNavetec,
      { id: "offracer", marca: "OFFRACER", skuId: null },
    ]);

    expect(alcance.semMarca?.governo).toBe("NENHUMA");
    expect(alcance.totais.cobertos).toBe(135 + 1049);
    expect(alcance.totais.naReposicao - alcance.totais.cobertos).toBe(4);
  });

  it("ordena por quem mais destrava: venda recente, depois tamanho", () => {
    expect(calcularAlcance(grupos, []).marcas.map((m) => m.marca)).toEqual(["OFFRACER", "NAVETEC", "PROJEÇÃO"]);
  });

  it("regra de uma marca que saiu do catálogo é órfã — não governa nada e a tela precisa dizer", () => {
    const alcance = calcularAlcance(grupos, [padrao, { id: "velha", marca: "MARCA ANTIGA", skuId: null }]);

    expect(alcance.regrasOrfas).toEqual(["MARCA ANTIGA"]);
  });

  it("regra por SKU não conta como regra de marca nem como padrão", () => {
    const alcance = calcularAlcance(grupos, [{ id: "sku", marca: null, skuId: "uuid-do-sku" }]);

    expect(alcance.padraoId).toBeNull();
    expect(alcance.totais.cobertos).toBe(3);
  });
});

describe("novosCobertos", () => {
  it("o padrão, num catálogo sem regra, destrava tudo menos o que já tinha regra própria", () => {
    expect(novosCobertos(calcularAlcance(grupos, []), { tipo: "PADRAO" })).toEqual({
      skus: 1188 - 3,
      comVenda: 780 - 2,
    });
  });

  it("uma marca, sem padrão, destrava só os SKUs dela", () => {
    expect(novosCobertos(calcularAlcance(grupos, []), { tipo: "MARCA", marca: "NAVETEC" })).toEqual({
      skus: 135,
      comVenda: 117,
    });
  });

  it("com padrão, uma regra de marca não destrava ninguém — só troca os números da política", () => {
    expect(novosCobertos(calcularAlcance(grupos, [padrao]), { tipo: "MARCA", marca: "NAVETEC" })).toEqual({
      skus: 0,
      comVenda: 0,
    });
  });
});

describe("governadosPelaRegra", () => {
  it("remover a regra de uma marca manda os SKUs dela para o padrão, quando ele existe", () => {
    expect(
      governadosPelaRegra(calcularAlcance(grupos, [padrao, regraNavetec]), { tipo: "MARCA", marca: "NAVETEC" }),
    ).toEqual({ skus: 135, comVenda: 117, destinoSemEla: "PADRAO" });
  });

  it("sem padrão, remover a regra da marca deixa os SKUs dela sem sugestão", () => {
    expect(governadosPelaRegra(calcularAlcance(grupos, [regraNavetec]), { tipo: "MARCA", marca: "NAVETEC" })).toMatchObject({
      destinoSemEla: "NENHUMA",
    });
  });

  it("o padrão governa o que nenhuma marca governa, fora os SKUs de regra própria", () => {
    expect(governadosPelaRegra(calcularAlcance(grupos, [padrao, regraNavetec]), { tipo: "PADRAO" })).toEqual({
      skus: 4 + (1049 - 3) + 0,
      comVenda: 2 + (661 - 2) + 0,
      destinoSemEla: "NENHUMA",
    });
  });
});
