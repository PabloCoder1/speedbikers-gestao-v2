import { describe, expect, it } from "vitest";

import { parseNfeXmlObject } from "./parse.js";

/**
 * Fixtures: objeto JS já convertido de XML (mesmo formato que
 * `fast-xml-parser` produziria, `det` sempre array). Construídos a partir
 * dos campos confirmados na documentação oficial (`docs/NFE.md` secao 2),
 * não de um XML real de fornecedor — ainda não recebido (`docs/NFE.md`
 * secao 3).
 */

const ACCESS_KEY = "35260812345678000190550010000012345123456789";

function baseNfe(overrides: Record<string, unknown> = {}) {
  return {
    NFe: {
      infNFe: {
        "@_Id": `NFe${ACCESS_KEY}`,
        "@_versao": "4.00",
        ide: {
          nNF: "12345",
          serie: "1",
          dhEmi: "2026-08-20T10:00:00-03:00",
          tpNF: "0",
        },
        emit: {
          CNPJ: "12345678000190",
          xNome: "Fornecedor Exemplo LTDA",
        },
        dest: {
          CNPJ: "98765432000110",
          xNome: "Speed Bikers Comercio LTDA",
        },
        det: [
          {
            "@_nItem": "1",
            prod: {
              cProd: "PARAFUSO-001",
              cEAN: "7891234567890",
              xProd: "Parafuso M6",
              NCM: "73181500",
              CFOP: "1102",
              uCom: "UN",
              qCom: "100.0000",
              vUnCom: "0.5000",
              vProd: "50.0000",
            },
          },
        ],
        ...overrides,
      },
    },
  };
}

describe("parseNfeXmlObject", () => {
  it("extrai os campos do documento e do item, envelopado em nfeProc", () => {
    const result = parseNfeXmlObject({ nfeProc: baseNfe() });

    expect(result).toEqual({
      ok: true,
      value: {
        accessKey: ACCESS_KEY,
        operationType: "ENTRADA",
        documentNumber: "12345",
        series: "1",
        issueDate: new Date("2026-08-20T10:00:00-03:00"),
        issuerCnpj: "12345678000190",
        issuerName: "Fornecedor Exemplo LTDA",
        recipientCnpj: "98765432000110",
        recipientName: "Speed Bikers Comercio LTDA",
        items: [
          {
            position: 0,
            supplierCode: "PARAFUSO-001",
            ean: "7891234567890",
            description: "Parafuso M6",
            ncm: "73181500",
            cfop: "1102",
            unit: "UN",
            quantity: 100,
            unitValue: 0.5,
            totalValue: 50,
          },
        ],
      },
    });
  });

  it("aceita NFe sem o envelope nfeProc (fornecedor manda só a nota)", () => {
    const result = parseNfeXmlObject(baseNfe());

    expect(result.ok).toBe(true);
  });

  it("chave de acesso remove o prefixo 'NFe' do atributo Id", () => {
    const result = parseNfeXmlObject({ nfeProc: baseNfe() });

    expect(result.ok && result.value.accessKey).toBe(ACCESS_KEY);
    expect(result.ok && result.value.accessKey).toHaveLength(44);
  });

  it("tpNF=1 vira SAIDA", () => {
    const result = parseNfeXmlObject({ nfeProc: baseNfe({ ide: { ...baseNfe().NFe.infNFe.ide, tpNF: "1" } }) });

    expect(result.ok && result.value.operationType).toBe("SAIDA");
  });

  it("cEAN 'SEM GTIN' vira ean nulo", () => {
    const nfe = baseNfe();
    nfe.NFe.infNFe.det[0]!.prod.cEAN = "SEM GTIN";

    const result = parseNfeXmlObject({ nfeProc: nfe });

    expect(result.ok && result.value.items[0]?.ean).toBeNull();
  });

  it("múltiplos itens preservam a ordem e o índice de posição", () => {
    const nfe = baseNfe();
    nfe.NFe.infNFe.det = [
      { "@_nItem": "1", prod: { ...nfe.NFe.infNFe.det[0]!.prod, cProd: "A" } },
      { "@_nItem": "2", prod: { ...nfe.NFe.infNFe.det[0]!.prod, cProd: "B" } },
    ];

    const result = parseNfeXmlObject({ nfeProc: nfe });

    expect(result.ok && result.value.items.map((i) => [i.position, i.supplierCode])).toEqual([
      [0, "A"],
      [1, "B"],
    ]);
  });

  it("sem itens (det vazio): erro", () => {
    const nfe = baseNfe();
    nfe.NFe.infNFe.det = [];

    const result = parseNfeXmlObject({ nfeProc: nfe });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("sem item");
  });

  it("Id malformado (não é 'NFe' + 44 dígitos): erro", () => {
    const nfe = baseNfe();
    nfe.NFe.infNFe["@_Id"] = "NFe123";

    const result = parseNfeXmlObject({ nfeProc: nfe });

    expect(result.ok).toBe(false);
  });

  it("dhEmi inválido: erro", () => {
    const nfe = baseNfe();
    nfe.NFe.infNFe.ide.dhEmi = "não é uma data";

    const result = parseNfeXmlObject({ nfeProc: nfe });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("dhEmi");
  });

  it("valor numérico inválido no item (qCom não numérico): erro", () => {
    const nfe = baseNfe();
    nfe.NFe.infNFe.det[0]!.prod.qCom = "não é número";

    const result = parseNfeXmlObject({ nfeProc: nfe });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("item 1");
  });

  it("dest ausente: recipientCnpj/recipientName ficam nulos, não quebra", () => {
    const nfe = baseNfe();
    delete (nfe.NFe.infNFe as { dest?: unknown }).dest;

    const result = parseNfeXmlObject({ nfeProc: nfe });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.recipientCnpj).toBeNull();
    expect(result.ok && result.value.recipientName).toBeNull();
  });

  it("NCM/CFOP ausentes viram null, não quebram o parse", () => {
    const nfe = baseNfe();
    delete (nfe.NFe.infNFe.det[0]!.prod as { NCM?: string }).NCM;
    delete (nfe.NFe.infNFe.det[0]!.prod as { CFOP?: string }).CFOP;

    const result = parseNfeXmlObject({ nfeProc: nfe });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.items[0]?.ncm).toBeNull();
    expect(result.ok && result.value.items[0]?.cfop).toBeNull();
  });

  it("XML completamente fora do formato NF-e: erro descritivo, não exceção", () => {
    const result = parseNfeXmlObject({ algumaOutraCoisa: true });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("layout NF-e");
  });
});
