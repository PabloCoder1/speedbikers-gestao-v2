import { type DocumentoLido, type ItemLido, type LeituraDocumento, type LinhaPdf, type PedacoPdf } from "./tipos.js";

/**
 * As "instruções de preparação" de um envio ao Full, do Mercado Livre (D-375).
 *
 * É o documento que acompanha a remessa: por produto, o código do anúncio, o
 * código universal, o SKU e QUANTAS unidades vão. Para o estoque, é uma SAÍDA
 * da loja — a mercadoria deixa o armazém próprio e passa a viver no Full
 * (`fulfillment_stock_snapshots` é quem conta o que já chegou lá, D-204).
 *
 * **Este leitor trabalha com POSIÇÃO, não com ordem de leitura.** No PDF do ML
 * o nome do produto está numa coluna e a quantidade em outra; na sequência do
 * arquivo elas se intercalam, e casar pela ordem trocaria a quantidade de um
 * produto pela do vizinho. A regra medida no arquivo real: a quantidade fica na
 * coluna `x ≈ 237` e na MESMA faixa de altura do bloco do produto (o rótulo
 * "SKU:" aparece ~11 pontos abaixo do número).
 *
 * **Acentos não sobrevivem** a este PDF (a fonte não traz o mapa completo):
 * "instruções" sai "instrues". Por isso o reconhecimento usa "SKU:" e o número
 * do envio, nunca uma frase acentuada.
 */

/** A coluna das unidades no layout do ML, medida no arquivo real. */
const COLUNA_UNIDADES = { minimo: 225, maximo: 275 };

/** Distância vertical máxima entre o número de unidades e o "SKU:" do mesmo produto. */
const MESMA_FAIXA = 20;

interface Bloco {
  readonly sku: string;
  readonly pagina: number;
  readonly y: number;
  readonly descricao: string;
}

/**
 * Os blocos de produto, lidos das LINHAS já remontadas.
 *
 * Trabalhar com os pedaços crus partia o SKU ao meio: o Chrome escreve
 * "SKU: 2200" e "7" como dois pedaços posicionados, e o leitor devolvia "2200"
 * — um SKU que não existe. A linha remonta a palavra antes de qualquer regra.
 *
 * O bloco vai do "Código ML" até o próximo, e a descrição é o que sobra depois
 * da linha do SKU, sempre na coluna da esquerda.
 */
function lerBlocos(linhas: readonly LinhaPdf[]): Bloco[] {
  const blocos: Bloco[] = [];
  const naColunaDoProduto = (linha: LinhaPdf): boolean =>
    linha.celulas.every((c) => c.x < COLUNA_UNIDADES.minimo);

  for (const [indice, linha] of linhas.entries()) {
    const sku = /SKU:\s*([A-Za-z0-9._-]+)/.exec(linha.texto)?.[1];

    if (sku === undefined) continue;

    const descricao: string[] = [];

    for (const seguinte of linhas.slice(indice + 1)) {
      if (seguinte.pagina !== linha.pagina) break;
      // "C.digo": o acento não sobrevive à fonte deste PDF, e o byte varia.
      if (/C.?digo\s*(ML|universal)|SKU:/i.test(seguinte.texto)) break;
      if (!naColunaDoProduto(seguinte)) continue;

      descricao.push(seguinte.texto.trim());

      // Duas linhas bastam: a terceira já é o próximo bloco ou instrução.
      if (descricao.length === 2) break;
    }

    blocos.push({ sku, pagina: linha.pagina, y: linha.y, descricao: descricao.join(" ").trim() });
  }

  return blocos;
}

export function lerEnvioFullMl(linhas: readonly LinhaPdf[], pedacos: readonly PedacoPdf[]): LeituraDocumento {
  if (linhas.length === 0) {
    return { ok: false, motivo: "não foi possível ler texto neste PDF — ele pode ser uma imagem digitalizada" };
  }

  const texto = linhas.map((l) => l.texto).join("\n");

  // "Lista de produtos e instrues de preparao" (sem acento, como o PDF sai).
  if (!/Lista de produtos e instru/i.test(texto) && !/preparation.instructions/i.test(texto)) {
    return { ok: false, motivo: "este PDF não parece as instruções de preparação de um envio ao Full" };
  }

  /*
    Reconhecido o layout, a quantidade DEPENDE da posição: sem os pedaços não
    há coluna, e adivinhar pela ordem trocaria a quantidade de um produto pela
    do vizinho. Recusar é a resposta certa.
  */
  if (pedacos.length === 0) {
    return { ok: false, motivo: "não foi possível ler as colunas deste PDF do Mercado Livre" };
  }

  const blocos = lerBlocos(linhas);

  if (blocos.length === 0) {
    return { ok: false, motivo: "nenhum SKU foi reconhecido nas instruções de preparação" };
  }

  const unidades = pedacos.filter(
    (p) => p.x >= COLUNA_UNIDADES.minimo && p.x <= COLUNA_UNIDADES.maximo && /^\d+$/.test(p.texto.trim()),
  );

  const usadas = new Set<PedacoPdf>();
  const itens: ItemLido[] = [];
  const semQuantidade: string[] = [];

  for (const bloco of blocos) {
    const candidatas = unidades
      .filter((u) => !usadas.has(u) && u.pagina === bloco.pagina && Math.abs(u.y - bloco.y) <= MESMA_FAIXA)
      .sort((a, b) => Math.abs(a.y - bloco.y) - Math.abs(b.y - bloco.y));

    const escolhida = candidatas[0];

    if (escolhida === undefined) {
      semQuantidade.push(bloco.sku);
      continue;
    }

    usadas.add(escolhida);

    itens.push({
      posicao: itens.length + 1,
      codigo: bloco.sku,
      descricao: bloco.descricao === "" ? bloco.sku : bloco.descricao,
      quantidade: Number.parseInt(escolhida.texto.trim(), 10),
      unidade: null,
      ean: null,
      ncm: null,
      cfop: null,
      valorUnitario: null,
      valorTotal: null,
    });
  }

  /*
    Produto sem quantidade na coluna é recusa do documento INTEIRO, não item
    faltando: aplicar metade de um envio ao Full deixaria o estoque pela metade,
    e ninguém veria o que ficou de fora.
  */
  if (semQuantidade.length > 0) {
    return {
      ok: false,
      motivo: `não foi possível ler a quantidade de ${String(semQuantidade.length)} produto(s) (${semQuantidade
        .slice(0, 3)
        .join(", ")}) — envie o arquivo original do Mercado Livre`,
    };
  }

  const numero = /#(\d{5,})/.exec(texto)?.[1] ?? null;

  const documento: DocumentoLido = {
    tipo: "ENVIO_FULL_ML_PDF",
    // Envio ao Full tira mercadoria do armazém próprio.
    direcao: "SAIDA",
    numero,
    serie: null,
    chave: null,
    emitidoEm: null,
    emitenteCnpj: null,
    emitenteNome: null,
    referencia: numero === null ? "Envio ao Full" : `Envio ao Full #${numero}`,
    itens,
  };

  return { ok: true, valor: documento };
}
