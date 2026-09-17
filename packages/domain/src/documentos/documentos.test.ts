import { describe, expect, it } from "vitest";

import { lerDanfe } from "./danfe.js";
import { lerEnvioFullMl } from "./envio-full-ml.js";
import { lerDocumentoPdf } from "./ler-documento.js";
import { lerSaidaUpseller } from "./saida-upseller.js";
import type { LinhaPdf, PedacoPdf } from "./tipos.js";

/**
 * Os três layouts de PDF (D-375).
 *
 * As fixtures são MONTADAS aqui, com a forma medida nos arquivos reais que o
 * dono mandou (um DANFE de transferência, um "Pedido de Saída" do UpSeller e as
 * instruções de envio ao Full). Dado real de fornecedor não entra no
 * repositório (`docs/NFE.md`), então CNPJ, nomes e códigos são fictícios — o
 * que se preserva é a ESTRUTURA: as colunas, a ordem e onde cada número mora.
 */

let proximoY = 800;

function linha(celulas: readonly (readonly [number, string])[], opcoes: { pagina?: number; y?: number } = {}): LinhaPdf {
  const y = opcoes.y ?? (proximoY -= 12);

  return {
    pagina: opcoes.pagina ?? 0,
    y,
    celulas: celulas.map(([x, texto]) => ({ x, texto })),
    celulasTexto: undefined,
    texto: celulas.map(([, texto]) => texto).join(""),
  } as unknown as LinhaPdf;
}

const CNPJ_PROPRIO = "12345678000190";
const CNPJ_FORNECEDOR = "98765432000155";

// ---------------------------------------------------------------- DANFE
function danfeFixture(): LinhaPdf[] {
  proximoY = 800;

  return [
    linha([[7, "RECEBEMOS DE FORNECEDOR EXEMPLO LTDA OS PRODUTOS"]]),
    linha([[7, "IDENTIFICAÇÃO DO EMITENTE"]]),
    linha([[7, "FORNECEDOR EXEMPLO LTDA"]]),
    linha([[7, "DANFE"]]),
    linha([[7, "CHAVE DE ACESSO"]]),
    linha([[7, "3526 0812 3456 7800 0190 5500 1000 0012 3451 2345 6789"]]),
    linha([[7, "CNPJ / CPF"]]),
    linha([[7, "98.765.432/0001-55"]]),
    linha([[7, "DESTINATÁRIO / REMETENTE"]]),
    linha([[7, "12.345.678/0001-90"]]),
    linha([[7, "Nº. 000.012.345"]]),
    linha([[7, "Série 003"]]),
    linha([[7, "DATA DA EMISSÃO"]]),
    linha([[7, "20/08/2026"]]),
    // O cabeçalho da tabela: três linhas, como os emissores desenham.
    linha([
      [361, "VALOR"],
      [395, "VALOR"],
    ]),
    linha([
      [6, "CÓDIGO PRODUTO"],
      [81, "DESCRIÇÃO DO PRODUTO / SERVIÇO"],
      [212, "NCM/SH"],
      [273, "CFOP"],
      [296, "UN"],
      [321, "QUANT"],
    ]),
    linha([
      [364, "UNIT"],
      [396, "TOTAL"],
    ]),
    linha([
      [17, "COD-1"],
      [61, "MANETE ESPORTIVA"],
      [210, "87141000"],
      [274, "6152"],
      [293, "PECAS"],
      [321, "1.000,0000"],
      [368, "7,9541"],
      [396, "7.954,10"],
    ]),
    linha([[61, "COMPATIVEL COM CG 160"]]),
    linha([
      [17, "COD-2"],
      [61, "RETROVISOR CROMADO"],
      [210, "87141000"],
      [274, "6152"],
      [293, "PECAS"],
      [330, "65,0000"],
      [368, "8,0000"],
      [402, "520,00"],
    ]),
    linha([[7, "DADOS ADICIONAIS"]]),
  ];
}

describe("DANFE", () => {
  it("lê itens, valores e a chave; a direção sai do CNPJ da casa", () => {
    const resultado = lerDanfe(danfeFixture(), CNPJ_PROPRIO);

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    const documento = resultado.valor;

    expect(documento.tipo).toBe("DANFE_PDF");
    // Emitente é o fornecedor, destinatário somos nós: entrada (D-053).
    expect(documento.direcao).toBe("ENTRADA");
    // "Nº. 000.012.345" -> "12345": zero à esquerda é enfeite de impressão.
    expect(documento.numero).toBe("12345");
    expect(documento.serie).toBe("003");
    expect(documento.chave).toBe("35260812345678000190550010000012345123456789");
    expect(documento.emitenteCnpj).toBe(CNPJ_FORNECEDOR);
    expect(documento.emitenteNome).toBe("FORNECEDOR EXEMPLO LTDA");
    expect(documento.emitidoEm).toBe("2026-08-20T12:00:00.000Z");
    expect(documento.itens).toHaveLength(2);
    expect(documento.itens[0]).toMatchObject({
      posicao: 1,
      codigo: "COD-1",
      // A linha de continuação entra na descrição do item de cima.
      descricao: "MANETE ESPORTIVA COMPATIVEL COM CG 160",
      quantidade: 1000,
      unidade: "PECAS",
      valorUnitario: 7.9541,
      valorTotal: 7954.1,
    });
    expect(documento.itens[1]).toMatchObject({ codigo: "COD-2", quantidade: 65, valorTotal: 520 });
  });

  it("emitente igual ao nosso é SAÍDA", () => {
    const comNotaPropria = danfeFixture().map((l) =>
      l.texto === "98.765.432/0001-55" ? linha([[7, "12.345.678/0001-90"]], { y: l.y }) : l,
    );

    const resultado = lerDanfe(comNotaPropria, CNPJ_PROPRIO);

    expect(resultado.ok && resultado.valor.direcao).toBe("SAIDA");
  });

  it("sem o CNPJ da organização no documento, recusa em vez de adivinhar a direção", () => {
    const resultado = lerDanfe(danfeFixture(), "11111111000111");

    expect(resultado).toEqual({
      ok: false,
      motivo: "o CNPJ da organização não aparece neste DANFE — sem ele não dá para decidir entrada ou saída",
    });
  });

  it("PDF que não é DANFE é recusado com o motivo", () => {
    expect(lerDanfe([linha([[0, "RELATÓRIO QUALQUER"]])], CNPJ_PROPRIO)).toEqual({
      ok: false,
      motivo: "este PDF não parece um DANFE",
    });
  });
});

// ---------------------------------------------------------------- UpSeller
function upsellerFixture(): LinhaPdf[] {
  proximoY = 800;

  return [
    linha([[15, "Pedido de Saída"]]),
    linha([[599, "N° da Saída: OUT12467"]]),
    linha([[599, "Imprimir: 17/09/2026 15:59"]]),
    linha([
      [15, "Armazém:"],
      [86, "EST"],
      [113, "OQUE LOJA"],
      [217, "Operador:"],
      [289, "operador@exemplo.com"],
    ]),
    linha([[15, "Observação"]]),
    linha([[15, "ENVIO FULL #77375684 CONTA 1"]]),
    linha([
      [37, "#"],
      [79, "SKU"],
      [585, "Estante"],
      [739, "Qtd."],
    ]),
    linha([
      [37, "1"],
      [131, "BAU05"],
      [631, "-"],
      [740, "×"],
      [752, "20"],
    ]),
    linha([
      [131, "Bau "],
      [160, "T"],
      [168, "raseiro Plástico 45L"],
    ]),
    linha([
      [27, "Total"],
      [740, "×"],
      [752, "20"],
    ]),
  ];
}

describe("Pedido de Saída do UpSeller", () => {
  it("lê número, armazém, observação e os itens", () => {
    const resultado = lerSaidaUpseller(upsellerFixture());

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    const documento = resultado.valor;

    expect(documento.tipo).toBe("SAIDA_UPSELLER_PDF");
    expect(documento.direcao).toBe("SAIDA");
    expect(documento.numero).toBe("OUT12467");
    expect(documento.referencia).toBe("Armazém ESTOQUE LOJA · ENVIO FULL #77375684 CONTA 1");
    expect(documento.emitidoEm).toBe("2026-09-17T15:59:00.000-03:00");
    // A descrição vem da linha de baixo, com a palavra remontada.
    expect(documento.itens).toEqual([
      {
        posicao: 1,
        codigo: "BAU05",
        descricao: "Bau Traseiro Plástico 45L",
        quantidade: 20,
        unidade: null,
        ean: null,
        ncm: null,
        cfop: null,
        valorUnitario: null,
        valorTotal: null,
      },
    ]);
  });

  it("para no Total: o rodapé não vira item", () => {
    const resultado = lerSaidaUpseller(upsellerFixture());

    expect(resultado.ok && resultado.valor.itens).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- Envio ao Full
function mlFixture(): { linhas: LinhaPdf[]; pedacos: PedacoPdf[] } {
  const linhas: LinhaPdf[] = [
    linha([[38, "Frete"]], { y: 700 }),
    linha([[38, "#77036991"]], { y: 690 }),
    linha([[38, "Lista de produtos e instrues de preparao"]], { y: 680 }),
    linha([[38, "Cdigo ML: UPKA39543 Cdigo universal: 7897448139767 SKU: 632008"]], { y: 594 }),
    linha([[38, "Kit Polia Correia Roletes Dianteiro Nmax 160"]], { y: 583 }),
    linha([[38, "Cdigo ML: YVND84807 Cdigo universal: 023315123103 SKU: BFE-VM"]], { y: 533 }),
    linha([[38, "Burrinho Freio Esportivo Titan"]], { y: 522 }),
  ];

  const pedacos: PedacoPdf[] = [
    { pagina: 0, x: 237, y: 605, texto: "2" },
    { pagina: 0, x: 237, y: 545, texto: "10" },
    // Ruído da coluna do código universal: não é quantidade.
    { pagina: 0, x: 203, y: 594, texto: "7776" },
  ];

  return { linhas, pedacos };
}

describe("instruções de envio ao Full", () => {
  it("casa a quantidade da COLUNA com o produto da mesma faixa de altura", () => {
    const { linhas, pedacos } = mlFixture();
    const resultado = lerEnvioFullMl(linhas, pedacos);

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    expect(resultado.valor.tipo).toBe("ENVIO_FULL_ML_PDF");
    expect(resultado.valor.direcao).toBe("SAIDA");
    expect(resultado.valor.numero).toBe("77036991");
    expect(resultado.valor.referencia).toBe("Envio ao Full #77036991");
    expect(resultado.valor.itens.map((i) => [i.codigo, i.quantidade])).toEqual([
      ["632008", 2],
      ["BFE-VM", 10],
    ]);
    expect(resultado.valor.itens[0]?.descricao).toBe("Kit Polia Correia Roletes Dianteiro Nmax 160");
  });

  /**
   * Meio envio aplicado é pior que envio nenhum: o estoque ficaria errado sem
   * ninguém ver o que faltou.
   */
  it("produto sem quantidade na coluna recusa o documento inteiro", () => {
    const { linhas, pedacos } = mlFixture();
    const resultado = lerEnvioFullMl(linhas, pedacos.filter((p) => p.texto !== "10"));

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;

    expect(resultado.motivo).toContain("BFE-VM");
    expect(resultado.motivo).toContain("quantidade");
  });
});

// ---------------------------------------------------------------- despachante
describe("qual leitor atende o PDF", () => {
  it("escolhe pelo conteúdo, não pelo nome do arquivo", () => {
    expect(lerDocumentoPdf(upsellerFixture(), [], CNPJ_PROPRIO)).toMatchObject({
      ok: true,
      valor: { tipo: "SAIDA_UPSELLER_PDF" },
    });

    const ml = mlFixture();

    expect(lerDocumentoPdf(ml.linhas, ml.pedacos, CNPJ_PROPRIO)).toMatchObject({
      ok: true,
      valor: { tipo: "ENVIO_FULL_ML_PDF" },
    });

    expect(lerDocumentoPdf(danfeFixture(), [], CNPJ_PROPRIO)).toMatchObject({
      ok: true,
      valor: { tipo: "DANFE_PDF" },
    });
  });

  it("PDF sem texto diz o que fazer, e não 'documento vazio'", () => {
    expect(lerDocumentoPdf([], [], CNPJ_PROPRIO)).toEqual({
      ok: false,
      motivo:
        "não foi possível ler texto neste PDF — se ele é uma imagem digitalizada, envie o XML da nota ou o PDF original",
    });
  });

  it("layout desconhecido nomeia os três que esta casa lê", () => {
    const resultado = lerDocumentoPdf([linha([[0, "EXTRATO BANCÁRIO"]], { y: 10 })], [], CNPJ_PROPRIO);

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;

    expect(resultado.motivo).toContain("DANFE");
    expect(resultado.motivo).toContain("Pedido de Saída");
    expect(resultado.motivo).toContain("Full");
  });
});
