import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { lerLinhasDoPdf, lerPedacosDoPdf } from "./pdf-texto.js";

/**
 * O extrator, contra PDFs montados aqui.
 *
 * **Os arquivos reais não entram no repositório** (`docs/NFE.md`: nunca publicar
 * dado de fornecedor). O que estes testes fixam é o COMPORTAMENTO medido neles:
 * texto comprimido, fonte CID com `ToUnicode`, palavra partida em pedaços,
 * coluna à direita e imagem que não é texto.
 */

function pdf(conteudo: string, { comprimido = true }: { comprimido?: boolean } = {}): Uint8Array {
  const corpo = comprimido ? deflateSync(Buffer.from(conteudo, "latin1")) : Buffer.from(conteudo, "latin1");

  return Buffer.concat([
    Buffer.from("%PDF-1.7\n1 0 obj\n<< /Length 0 >>\nstream\n", "latin1"),
    corpo,
    Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
  ]);
}

/** Um texto na posição (x, y), no formato que os emissores produzem. */
const escrever = (x: number, y: number, texto: string): string =>
  `BT 1 0 0 1 ${String(x)} ${String(y)} Tm (${texto}) Tj ET\n`;

describe("texto posicionado", () => {
  it("lê texto comprimido e devolve a posição de cada pedaço", () => {
    const bytes = pdf(`${escrever(30, 700, "Pedido de Saida")}${escrever(400, 700, "20")}`);
    const pedacos = lerPedacosDoPdf(bytes);

    expect(pedacos).toEqual([
      { pagina: 0, x: 30, y: 700, texto: "Pedido de Saida" },
      { pagina: 0, x: 400, y: 700, texto: "20" },
    ]);
  });

  it("stream sem compressão também é lido", () => {
    const bytes = pdf(escrever(10, 10, "SEM COMPRESSAO"), { comprimido: false });

    expect(lerLinhasDoPdf(bytes)[0]?.texto).toBe("SEM COMPRESSAO");
  });

  /**
   * O caso que quebrou o primeiro leitor: o Chrome escreve a MESMA palavra em
   * vários pedaços posicionados ("EST" + "OQUE LOJA"). Colar sem espaço é o que
   * devolve a palavra inteira; a separação entre colunas fica no `x`.
   */
  it("junta pedaços da mesma palavra e mantém as colunas separadas", () => {
    const bytes = pdf(
      `${escrever(15, 500, "Armazem:")}${escrever(86, 500, "EST")}${escrever(113, 500, "OQUE LOJA")}${escrever(740, 500, "20")}`,
    );
    const [linha] = lerLinhasDoPdf(bytes);

    expect(linha?.texto).toBe("Armazem:ESTOQUE LOJA20");
    expect(linha?.celulas.map((c) => c.texto)).toEqual(["Armazem:", "EST", "OQUE LOJA", "20"]);
    expect(linha?.celulas.at(-1)?.x).toBe(740);
  });

  it("pedaços na mesma altura viram uma linha; alturas diferentes, linhas diferentes", () => {
    const bytes = pdf(`${escrever(10, 300, "A")}${escrever(50, 299, "B")}${escrever(10, 280, "C")}`);
    const linhas = lerLinhasDoPdf(bytes);

    expect(linhas.map((l) => l.texto)).toEqual(["AB", "C"]);
  });

  /**
   * A ordem é a do ARQUIVO, não a da altura: o PDF que o Chrome imprime inverte
   * o eixo vertical, e ordenar por `y` punha o rodapé antes do cabeçalho.
   */
  it("mantém a ordem em que o emissor escreveu, mesmo com o eixo invertido", () => {
    const bytes = pdf(`${escrever(10, 100, "CABECALHO")}${escrever(10, 300, "RODAPE")}`);

    expect(lerLinhasDoPdf(bytes).map((l) => l.texto)).toEqual(["CABECALHO", "RODAPE"]);
  });

  it("fonte CID: o texto vem em hexadecimal e o ToUnicode traduz", () => {
    const mapa =
      "/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 beginbfchar <0041> <0053> endbfchar 1 beginbfrange <0042> <0043> <004B> endbfrange endcmap end end";
    const bytes = pdf(`${mapa}\nBT 1 0 0 1 10 10 Tm <004100420043> Tj ET`);

    // 0041 -> "S", e a faixa 0042-0043 -> "K", "L".
    expect(lerLinhasDoPdf(bytes)[0]?.texto).toBe("SKL");
  });

  it("PDF sem texto (imagem) devolve vazio, e não um documento sem itens", () => {
    const binario = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0xff, 0xe0, 0x54, 0x6a]);
    const bytes = Buffer.concat([
      Buffer.from("%PDF-1.7\n1 0 obj\nstream\n", "latin1"),
      binario,
      Buffer.from("\nendstream\n%%EOF", "latin1"),
    ]);

    expect(lerLinhasDoPdf(bytes)).toEqual([]);
  });

  it("arquivo que não é PDF não estoura — devolve vazio", () => {
    expect(lerLinhasDoPdf(Buffer.from("isto é um texto qualquer", "utf8"))).toEqual([]);
  });
});
