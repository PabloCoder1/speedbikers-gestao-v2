import { describe, expect, it } from "vitest";

import { parseNfeXmlObject } from "./parse.js";

/**
 * Fixtures: objeto JS já convertido de XML (mesmo formato que
 * `fast-xml-parser` produziria, `det` sempre array). Construídas a partir
 * dos campos confirmados na documentação oficial (`docs/NFE.md` secao 2) e
 * validadas contra a ESTRUTURA do primeiro XML real de fornecedor recebido
 * do usuário em 2026-08-22 — dados de fornecedor/CNPJ trocados por valores
 * fictícios (`docs/NFE.md` secao "Como adicionar novo campo confirmado":
 * nunca publicar dado sensível de fornecedor real no repositório).
 */

const ACCESS_KEY = "35260812345678000190550010000012345123456789";
const OWN_CNPJ = "27810945000206"; // CNPJ real da Speed Bikers — não é sensível, é a própria empresa.
const SUPPLIER_CNPJ = "12345678000190"; // fictício.

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
          tpNF: "1",
          natOp: "VENDA P/FORA DO ESTADO",
        },
        emit: {
          CNPJ: SUPPLIER_CNPJ,
          xNome: "Fornecedor Exemplo LTDA",
        },
        dest: {
          CNPJ: OWN_CNPJ,
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
              CFOP: "6101",
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
    const result = parseNfeXmlObject({ nfeProc: baseNfe() }, OWN_CNPJ);

    expect(result).toEqual({
      ok: true,
      value: {
        accessKey: ACCESS_KEY,
        operationType: "ENTRADA",
        documentNumber: "12345",
        series: "1",
        issueDate: new Date("2026-08-20T10:00:00-03:00"),
        issuerCnpj: SUPPLIER_CNPJ,
        issuerName: "Fornecedor Exemplo LTDA",
        recipientCnpj: OWN_CNPJ,
        recipientName: "Speed Bikers Comercio LTDA",
        items: [
          {
            position: 0,
            supplierCode: "PARAFUSO-001",
            ean: "7891234567890",
            description: "Parafuso M6",
            ncm: "73181500",
            cfop: "6101",
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
    const result = parseNfeXmlObject(baseNfe(), OWN_CNPJ);

    expect(result.ok).toBe(true);
  });

  it("chave de acesso remove o prefixo 'NFe' do atributo Id", () => {
    const result = parseNfeXmlObject({ nfeProc: baseNfe() }, OWN_CNPJ);

    expect(result.ok && result.value.accessKey).toBe(ACCESS_KEY);
    expect(result.ok && result.value.accessKey).toHaveLength(44);
  });

  describe("direção do movimento — Speed Bikers como destinatária ou emitente, NÃO tpNF sozinho", () => {
    it("achado real (2026-08-22): tpNF=1 (saída DO FORNECEDOR) + Speed Bikers como dest = ENTRADA no nosso estoque", () => {
      // Este é exatamente o padrão do primeiro XML real recebido: uma compra
      // de fornecedor chega com tpNF=1 porque É saída do lado de quem vendeu.
      const nfe = baseNfe();
      nfe.NFe.infNFe.ide.tpNF = "1";

      const result = parseNfeXmlObject({ nfeProc: nfe }, OWN_CNPJ);

      expect(result.ok && result.value.operationType).toBe("ENTRADA");
    });

    it("Speed Bikers como emitente (nota de saída própria) = SAIDA, independente de tpNF", () => {
      const nfe = baseNfe();
      nfe.NFe.infNFe.emit = { CNPJ: OWN_CNPJ, xNome: "Speed Bikers Comercio LTDA" };
      nfe.NFe.infNFe.dest = { CNPJ: "99999999000199", xNome: "Cliente Qualquer" };

      const result = parseNfeXmlObject({ nfeProc: nfe }, OWN_CNPJ);

      expect(result.ok && result.value.operationType).toBe("SAIDA");
    });

    it("nem emitente nem destinatário batem com o CNPJ da organização: erro, não adivinha", () => {
      const nfe = baseNfe();
      nfe.NFe.infNFe.emit = { CNPJ: "11111111000100", xNome: "Empresa A" };
      nfe.NFe.infNFe.dest = { CNPJ: "22222222000100", xNome: "Empresa B" };

      const result = parseNfeXmlObject({ nfeProc: nfe }, OWN_CNPJ);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain("nem emitente");
    });

    it("CNPJ com máscara (pontuação) compara igual a CNPJ só com dígitos", () => {
      const nfe = baseNfe();
      nfe.NFe.infNFe.dest = { CNPJ: "27.810.945/0002-06", xNome: "Speed Bikers Comercio LTDA" };

      const result = parseNfeXmlObject({ nfeProc: nfe }, OWN_CNPJ);

      expect(result.ok && result.value.operationType).toBe("ENTRADA");
    });
  });

  it("cEAN 'SEM GTIN' vira ean nulo", () => {
    const nfe = baseNfe();
    nfe.NFe.infNFe.det[0]!.prod.cEAN = "SEM GTIN";

    const result = parseNfeXmlObject({ nfeProc: nfe }, OWN_CNPJ);

    expect(result.ok && result.value.items[0]?.ean).toBeNull();
  });

  it("múltiplos itens preservam a ordem e o índice de posição", () => {
    const nfe = baseNfe();
    nfe.NFe.infNFe.det = [
      { "@_nItem": "1", prod: { ...nfe.NFe.infNFe.det[0]!.prod, cProd: "A" } },
      { "@_nItem": "2", prod: { ...nfe.NFe.infNFe.det[0]!.prod, cProd: "B" } },
    ];

    const result = parseNfeXmlObject({ nfeProc: nfe }, OWN_CNPJ);

    expect(result.ok && result.value.items.map((i) => [i.position, i.supplierCode])).toEqual([
      [0, "A"],
      [1, "B"],
    ]);
  });

  it("sem itens (det vazio): erro", () => {
    const nfe = baseNfe();
    nfe.NFe.infNFe.det = [];

    const result = parseNfeXmlObject({ nfeProc: nfe }, OWN_CNPJ);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("sem item");
  });

  it("Id malformado (não é 'NFe' + 44 dígitos): erro", () => {
    const nfe = baseNfe();
    nfe.NFe.infNFe["@_Id"] = "NFe123";

    const result = parseNfeXmlObject({ nfeProc: nfe }, OWN_CNPJ);

    expect(result.ok).toBe(false);
  });

  it("dhEmi inválido: erro", () => {
    const nfe = baseNfe();
    nfe.NFe.infNFe.ide.dhEmi = "não é uma data";

    const result = parseNfeXmlObject({ nfeProc: nfe }, OWN_CNPJ);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("dhEmi");
  });

  it("valor numérico inválido no item (qCom não numérico): erro", () => {
    const nfe = baseNfe();
    nfe.NFe.infNFe.det[0]!.prod.qCom = "não é número";

    const result = parseNfeXmlObject({ nfeProc: nfe }, OWN_CNPJ);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("item 1");
  });

  it("dest ausente: recipientCnpj/recipientName ficam nulos — só funciona se emit bater com a organização", () => {
    const nfe = baseNfe();
    nfe.NFe.infNFe.emit = { CNPJ: OWN_CNPJ, xNome: "Speed Bikers Comercio LTDA" };
    delete (nfe.NFe.infNFe as { dest?: unknown }).dest;

    const result = parseNfeXmlObject({ nfeProc: nfe }, OWN_CNPJ);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.operationType).toBe("SAIDA");
    expect(result.ok && result.value.recipientCnpj).toBeNull();
    expect(result.ok && result.value.recipientName).toBeNull();
  });

  it("NCM/CFOP ausentes viram null, não quebram o parse", () => {
    const nfe = baseNfe();
    delete (nfe.NFe.infNFe.det[0]!.prod as { NCM?: string }).NCM;
    delete (nfe.NFe.infNFe.det[0]!.prod as { CFOP?: string }).CFOP;

    const result = parseNfeXmlObject({ nfeProc: nfe }, OWN_CNPJ);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.items[0]?.ncm).toBeNull();
    expect(result.ok && result.value.items[0]?.cfop).toBeNull();
  });

  it("XML completamente fora do formato NF-e: erro descritivo, não exceção", () => {
    const result = parseNfeXmlObject({ algumaOutraCoisa: true }, OWN_CNPJ);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("layout NF-e");
  });

  it("campos desconhecidos (imposto/IBSCBS, infAdic, infRespTec, transp, cobr, pag) são ignorados sem quebrar", () => {
    // O XML real trouxe um bloco <imposto> inteiro por item (ICMS, IPI, PIS,
    // COFINS, IBSCBS — a reforma tributária 2026) e blocos irrelevantes para
    // o ledger de estoque (infAdic, infRespTec, transp, cobr, pag). Nenhum
    // deles é validado; o parser lê só o que precisa.
    const nfe = baseNfe();
    (nfe.NFe.infNFe.det as unknown[])[0] = {
      "@_nItem": "1",
      prod: nfe.NFe.infNFe.det[0]!.prod,
      imposto: {
        vTotTrib: "6.99",
        IBSCBS: { CST: "000", cClassTrib: "000001", gIBSCBS: { vIBS: "1.49", vBC: "1492.69" } },
        ICMS: { ICMS00: { modBC: "3", orig: "0", CST: "00", vBC: "50.00", vICMS: "6.00", pICMS: "12.00" } },
      },
    };
    (nfe.NFe.infNFe as Record<string, unknown>).infAdic = { infCpl: "observação qualquer" };
    (nfe.NFe.infNFe as Record<string, unknown>).transp = { modFrete: "1" };

    const result = parseNfeXmlObject({ nfeProc: nfe }, OWN_CNPJ);

    expect(result.ok).toBe(true);
  });
});
