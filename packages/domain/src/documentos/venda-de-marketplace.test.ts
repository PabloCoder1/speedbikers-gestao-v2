import { describe, expect, it } from "vitest";

import { marketplaceDoIntermediador, normalizarCfop, recusaDeVendaDeMarketplace } from "./venda-de-marketplace.js";

const ML = "03007331000141";
const ML_FILIAL = "03007331000222";
const SHOPEE = "35635824000112";
const OUTRO = "12345678000190"; // fictício: um intermediador sem baixa pelo pedido na V3.

function xml(direcao: "ENTRADA" | "SAIDA", cfops: (string | null)[], intermediadorCnpj: string | null) {
  return { tipo: "NFE_XML" as const, direcao, cfops, intermediadorCnpj };
}

describe("normalizarCfop e o intermediador", () => {
  it("aceita o CFOP com e sem ponto e descarta o lixo de layout", () => {
    expect(normalizarCfop("5102")).toBe("5102");
    expect(normalizarCfop("5.102")).toBe("5102");
    expect(normalizarCfop("1/00 6152")).toBeNull();
    expect(normalizarCfop(null)).toBeNull();
  });

  it("casa pela raiz do CNPJ (matriz e filial) e só o ML e a Shopee", () => {
    expect(marketplaceDoIntermediador(ML)).toBe("ML");
    expect(marketplaceDoIntermediador(ML_FILIAL)).toBe("ML");
    expect(marketplaceDoIntermediador("35.635.824/0001-12")).toBe("SHOPEE");
    expect(marketplaceDoIntermediador(OUTRO)).toBeNull();
    expect(marketplaceDoIntermediador("0300733100014")).toBeNull();
    expect(marketplaceDoIntermediador(null)).toBeNull();
  });
});

describe("recusaDeVendaDeMarketplace (D-497)", () => {
  it("recusa a nota de venda do ML e da Shopee, dentro e fora do estado e com ST", () => {
    for (const cfop of ["5102", "6108", "5405", "6404", "5922"]) {
      expect(recusaDeVendaDeMarketplace(xml("SAIDA", [cfop], ML))?.codigo, cfop).toBe("SAIDA_VENDA_MARKETPLACE");
    }

    expect(recusaDeVendaDeMarketplace(xml("SAIDA", ["6102"], SHOPEE))).toEqual({
      codigo: "SAIDA_VENDA_MARKETPLACE",
      motivo: expect.stringContaining("Shopee") as string,
    });
  });

  it("deixa entrar a venda de balcão (sem intermediador) e a de outro intermediador", () => {
    expect(recusaDeVendaDeMarketplace(xml("SAIDA", ["5102"], null))).toBeNull();
    expect(recusaDeVendaDeMarketplace(xml("SAIDA", ["5102"], OUTRO))).toBeNull();
  });

  it("recusa a devolução de venda de marketplace pelo CFOP, qualquer que seja a direção lida", () => {
    for (const cfop of ["1202", "2202", "1411", "2411", "3202"]) {
      expect(recusaDeVendaDeMarketplace(xml("ENTRADA", [cfop], ML))?.codigo, cfop).toBe("DEVOLUCAO_VENDA_MARKETPLACE");
    }

    // A nota de entrada própria tem a casa como emitente: o CFOP decide, não a direção.
    expect(recusaDeVendaDeMarketplace(xml("SAIDA", ["1202"], SHOPEE))?.codigo).toBe("DEVOLUCAO_VENDA_MARKETPLACE");
    expect(recusaDeVendaDeMarketplace(xml("ENTRADA", ["1202"], null))).toBeNull();
  });

  it("não recusa o que não é venda: compra, devolução de compra, transferência, perda, brinde, ativo", () => {
    for (const cfop of ["1102", "2102", "5202", "6202", "5152", "6152", "1152", "5927", "5910", "5915", "5551", "1553", "5949"]) {
      expect(recusaDeVendaDeMarketplace(xml("SAIDA", [cfop], ML)), cfop).toBeNull();
    }
  });

  it("um item de venda basta para recusar a nota inteira", () => {
    expect(recusaDeVendaDeMarketplace(xml("SAIDA", ["5910", "5102", null], ML))?.codigo).toBe("SAIDA_VENDA_MARKETPLACE");
  });

  it("o DANFE de venda ou de devolução de venda pede o XML; os documentos de separação ficam com as regras deles", () => {
    expect(recusaDeVendaDeMarketplace({ tipo: "DANFE_PDF", direcao: "SAIDA", cfops: ["5.102"], intermediadorCnpj: null })?.codigo).toBe(
      "VENDA_PEDE_XML",
    );
    expect(recusaDeVendaDeMarketplace({ tipo: "DANFE_PDF", direcao: "ENTRADA", cfops: ["1.202"], intermediadorCnpj: null })?.codigo).toBe(
      "VENDA_PEDE_XML",
    );
    expect(recusaDeVendaDeMarketplace({ tipo: "DANFE_PDF", direcao: "ENTRADA", cfops: ["1.102"], intermediadorCnpj: null })).toBeNull();
    expect(recusaDeVendaDeMarketplace({ tipo: "SAIDA_UPSELLER_PDF", direcao: "SAIDA", cfops: [null], intermediadorCnpj: null })).toBeNull();
  });
});
