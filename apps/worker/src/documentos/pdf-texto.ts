import { inflateSync } from "node:zlib";

import type { CelulaPdf, LinhaPdf, PedacoPdf } from "@sb/domain";

/**
 * Texto de um PDF, sem dependência nova (D-375).
 *
 * **Por que escrever isto em vez de instalar uma biblioteca.** O projeto não
 * tem leitor de PDF: a `web` tem `pdf-lib` (que GERA PDF, não extrai texto) e o
 * worker tem `fast-xml-parser`. As candidatas de mercado (`pdfjs-dist`,
 * `pdf-parse`) trazem megabytes e superfície de execução para um caso estreito
 * e conhecido: três layouts, de dois produtores (Chrome/Skia imprimindo o
 * UpSeller e o Mercado Livre) mais o DANFE do emissor. O que precisamos é o
 * texto POSICIONADO, não renderização.
 *
 * **Como funciona.** Um PDF é uma lista de objetos; o texto vive em `stream`s
 * normalmente comprimidos com Flate. Dentro do stream, `Tj` e `TJ` recebem as
 * cadeias, e `Tm`/`Td`/`TD`/`T*` movem o cursor. Fonte simples escreve
 * `(texto) Tj`; fonte CID (o que o Chrome usa) escreve `<0048006f> Tj`, um
 * código de glifo por 4 dígitos, traduzido pelo dicionário `ToUnicode` do
 * próprio arquivo. Este módulo infla os streams de CONTEÚDO (imagem inflada é
 * ruído binário e fica de fora) e devolve cada pedaço de texto com a posição em
 * que ele foi escrito.
 *
 * **Por que a posição importa.** Nas instruções de envio do Mercado Livre, a
 * quantidade de cada produto está numa COLUNA à direita, não na mesma sequência
 * de leitura do nome. Sem `x`/`y` não há como dizer qual número pertence a qual
 * produto — e um número ligado ao produto errado vira estoque errado.
 *
 * **O que ele não faz, e por isso a tela precisa dizer:** PDF que é imagem
 * (digitalização, foto) não tem texto nenhum, e aqui sai vazio. Quem chama
 * trata o vazio como "não deu para ler", nunca como "documento sem itens".
 */

const LIMITE_STREAMS = 4000;

/**
 * Stream de CONTEÚDO ou de imagem? Um stream de conteúdo é quase todo ASCII
 * imprimível (operadores e coordenadas); uma imagem inflada é ruído binário, e
 * de vez em quando o ruído contém "Tj" por acaso — foi o que encheu a primeira
 * leitura do PDF do UpSeller de lixo. A proporção separa os dois sem precisar
 * interpretar o dicionário do objeto.
 */
function pareceTexto(conteudo: string): boolean {
  const amostra = conteudo.slice(0, 4096);

  if (amostra.length === 0) return false;

  let imprimiveis = 0;

  for (const caractere of amostra) {
    const codigo = caractere.charCodeAt(0);

    if (codigo === 9 || codigo === 10 || codigo === 13 || (codigo >= 32 && codigo <= 126)) imprimiveis += 1;
  }

  return imprimiveis / amostra.length > 0.85;
}

function inflarStreams(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes);
  const streams: string[] = [];

  let posicao = 0;

  while (streams.length < LIMITE_STREAMS) {
    const inicio = buffer.indexOf("stream", posicao);

    if (inicio === -1) break;

    let corpo = inicio + "stream".length;

    // A especificação manda CRLF ou LF depois da palavra `stream`.
    if (buffer[corpo] === 0x0d) corpo += 1;
    if (buffer[corpo] === 0x0a) corpo += 1;

    const fim = buffer.indexOf("endstream", corpo);

    if (fim === -1) break;

    const bruto = buffer.subarray(corpo, fim);

    posicao = fim + "endstream".length;

    try {
      const inflado = inflateSync(bruto).toString("latin1");

      if (pareceTexto(inflado)) streams.push(inflado);
    } catch {
      const texto = bruto.toString("latin1");

      if (texto.includes("Tj") || texto.includes("TJ")) streams.push(texto);
    }
  }

  return streams;
}

/** Junta todos os `ToUnicode`: código do glifo -> caractere. */
function montarMapa(streams: readonly string[]): Map<number, string> {
  const mapa = new Map<number, string>();

  const caractere = (hex: string): string => {
    const codigo = Number.parseInt(hex.slice(0, 4), 16);

    return Number.isFinite(codigo) ? String.fromCharCode(codigo) : "";
  };

  for (const stream of streams) {
    if (!stream.includes("beginbfchar") && !stream.includes("beginbfrange")) continue;

    for (const bloco of stream.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const par of (bloco[1] ?? "").matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        mapa.set(Number.parseInt(par[1] ?? "", 16), caractere(par[2] ?? ""));
      }
    }

    for (const bloco of stream.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const faixa of (bloco[1] ?? "").matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const de = Number.parseInt(faixa[1] ?? "", 16);
        const ate = Number.parseInt(faixa[2] ?? "", 16);
        const base = Number.parseInt((faixa[3] ?? "").slice(0, 4), 16);

        // Teto: faixa corrompida não pode virar laço de milhões.
        for (let codigo = de; codigo <= ate && codigo - de < 4096; codigo += 1) {
          mapa.set(codigo, String.fromCharCode(base + (codigo - de)));
        }
      }
    }
  }

  return mapa;
}

const ESCAPES: Record<string, string> = { n: " ", r: "", t: " ", b: "", f: "" };

/** `(texto\)com escape)` -> texto literal. */
function lerLiteral(bruto: string): string {
  let saida = "";

  for (let i = 0; i < bruto.length; i += 1) {
    const atual = bruto[i] ?? "";

    if (atual !== "\\") {
      saida += atual;
      continue;
    }

    const proximo = bruto[i + 1] ?? "";

    if (/\d/.test(proximo)) {
      const octal = /^\d{1,3}/.exec(bruto.slice(i + 1, i + 4))?.[0] ?? "";

      saida += String.fromCharCode(Number.parseInt(octal, 8));
      i += octal.length;
      continue;
    }

    saida += ESCAPES[proximo] ?? proximo;
    i += 1;
  }

  return saida;
}

const numeros = (trecho: string): number[] =>
  [...trecho.matchAll(/-?\d+(?:\.\d+)?/g)].map((n) => Number.parseFloat(n[0]));

/** Cada pedaço de texto do PDF, com a posição em que foi escrito. */
export function lerPedacosDoPdf(bytes: Uint8Array): PedacoPdf[] {
  const streams = inflarStreams(bytes);
  const mapa = montarMapa(streams);

  const decodificarHex = (hex: string): string => {
    const limpo = hex.replace(/\s/g, "");
    let saida = "";

    for (let i = 0; i + 4 <= limpo.length; i += 4) {
      saida += mapa.get(Number.parseInt(limpo.slice(i, i + 4), 16)) ?? "";
    }

    return saida;
  };

  const pedacos: PedacoPdf[] = [];

  streams.forEach((stream, pagina) => {
    if (!stream.includes("Tj") && !stream.includes("TJ")) return;

    let x = 0;
    let y = 0;
    let deslocamentoLinha = 12;

    for (const token of stream.matchAll(
      /(<[0-9A-Fa-f\s]*>|\((?:\\.|[^()\\])*\))\s*(Tj|')|\[([\s\S]*?)\]\s*TJ|((?:-?[\d.]+\s+)+)(Td|TD|Tm|TL)|(T\*|BT)/g,
    )) {
      const [bruto, , operador, , argumentos, posicional, reinicio] = token;

      if (reinicio !== undefined) {
        if (reinicio === "T*") y -= deslocamentoLinha;
        else {
          x = 0;
          y = 0;
        }

        continue;
      }

      if (posicional !== undefined) {
        const valores = numeros(argumentos ?? "");

        if (posicional === "Tm") {
          x = valores[4] ?? 0;
          y = valores[5] ?? 0;
        } else if (posicional === "TL") {
          deslocamentoLinha = valores[0] ?? deslocamentoLinha;
        } else {
          x += valores[0] ?? 0;
          y += valores[1] ?? 0;
          if (posicional === "TD") deslocamentoLinha = -(valores[1] ?? 0);
        }

        continue;
      }

      let texto = "";

      for (const parte of bruto.matchAll(/<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^()\\])*)\)/g)) {
        texto += parte[1] !== undefined ? decodificarHex(parte[1]) : lerLiteral(parte[2] ?? "");
      }

      // `'` é "desce uma linha e mostra".
      if (operador === "'") y -= deslocamentoLinha;

      if (texto.trim() !== "") pedacos.push({ pagina, x, y, texto });
    }
  });

  return pedacos;
}

/**
 * Junta as células de uma linha SEM acrescentar espaço.
 *
 * O Chrome parte a palavra em vários pedaços posicionados ("EST" + "OQUE
 * LOJA", "CONT" + "A"), e o espaço que separa palavras já vem DENTRO do
 * pedaço. Acrescentar espaço entre células reconstruiria a palavra partida com
 * um espaço no meio — foi o que aconteceu na primeira tentativa. Quem precisa
 * das COLUNAS (a tabela de itens) usa `celulas`, que preserva o `x`.
 */
function juntarCelulas(celulas: readonly CelulaPdf[]): string {
  return celulas
    .map((c) => c.texto)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tolerância de altura: pedaços dentro dela são a mesma linha visual. */
const MESMA_LINHA = 2.5;

/**
 * As linhas do PDF: pedaços na mesma altura, ordenados da esquerda para a
 * direita. É a forma que casa rótulo e valor de tabela — e a que permite ao
 * leitor do Mercado Livre achar a quantidade na coluna certa.
 */
export function lerLinhasDoPdf(bytes: Uint8Array): LinhaPdf[] {
  const pedacos = lerPedacosDoPdf(bytes);
  const linhas: { pagina: number; y: number; ordem: number; celulas: CelulaPdf[] }[] = [];

  for (const [ordem, pedaco] of pedacos.entries()) {
    const existente = linhas.find((l) => l.pagina === pedaco.pagina && Math.abs(l.y - pedaco.y) <= MESMA_LINHA);

    if (existente === undefined) {
      linhas.push({ pagina: pedaco.pagina, y: pedaco.y, ordem, celulas: [{ x: pedaco.x, texto: pedaco.texto }] });
      continue;
    }

    existente.celulas.push({ x: pedaco.x, texto: pedaco.texto });
  }

  /*
    A ORDEM É A DO ARQUIVO, não a da altura. O PDF que o Chrome imprime (o
    "Pedido de Saída" do UpSeller) aplica uma transformação que inverte o eixo
    vertical: ordenar por `y` decrescente punha o rodapé antes do cabeçalho, e o
    leitor de itens parava antes de começar. Emissores escrevem o conteúdo na
    ordem de leitura, e é essa ordem que vale aqui; `y` continua exposto para
    quem precisa casar colunas.
  */
  return linhas
    .sort((a, b) => (a.pagina === b.pagina ? a.ordem - b.ordem : a.pagina - b.pagina))
    .map((linha) => {
      const celulas = [...linha.celulas].sort((a, b) => a.x - b.x);

      return {
        pagina: linha.pagina,
        y: linha.y,
        celulas,
        texto: juntarCelulas(celulas),
      };
    })
    .filter((linha) => linha.texto !== "");
}

/** O texto inteiro, uma linha por linha — para achar rótulo solto. */
export function textoDoPdf(bytes: Uint8Array): string {
  return lerLinhasDoPdf(bytes)
    .map((linha) => linha.texto)
    .join("\n");
}
