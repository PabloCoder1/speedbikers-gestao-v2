import { numeroBr, type CelulaPdf, type DocumentoLido, type ItemLido, type LeituraDocumento, type LinhaPdf } from "./tipos.js";

/**
 * O "Pedido de Saída" impresso do UpSeller (D-375).
 *
 * É o documento que a operação já usa para separar mercadoria — inclusive para
 * montar envio ao Full ("ENVIO FULL #77375684 CONTA 1" na observação). Ele NÃO
 * é documento fiscal: não tem CNPJ, chave nem valor. O que ele tem é o que o
 * ledger precisa: SKU e quantidade, com número próprio (`OUT12467`) para a
 * idempotência.
 *
 * **O SKU aqui é o SKU DA CASA**, não o código de um fornecedor: a coluna sai
 * do nosso próprio catálogo. Mesmo assim o vínculo continua humano na tela de
 * conferência (D-133/NFE secao 3) — o importador não decide sozinho.
 */

interface Colunas {
  readonly indice: number;
  readonly sku: number;
  readonly quantidade: number;
}

/** O cabeçalho "# SKU Estante Qtd." — é ele que dá o `x` de cada coluna. */
function acharColunas(linhas: readonly LinhaPdf[]): { colunas: Colunas; linha: number } | null {
  for (const [indice, linha] of linhas.entries()) {
    const sku = linha.celulas.find((c) => /^SKU$/i.test(c.texto.trim()));
    const quantidade = linha.celulas.find((c) => /^Qtd\.?$/i.test(c.texto.trim()));
    const numero = linha.celulas.find((c) => c.texto.trim() === "#");

    if (sku === undefined || quantidade === undefined || numero === undefined) continue;

    return { linha: indice, colunas: { indice: numero.x, sku: sku.x, quantidade: quantidade.x } };
  }

  return null;
}

/**
 * A célula da coluna do SKU. É FAIXA, não proximidade: o cabeçalho "SKU" fica
 * alinhado à esquerda da coluna e o valor começa mais adiante (79 contra 131 no
 * arquivo real), então casar pelo `x` mais próximo não achava nada.
 */
function naColunaDoSku(linha: LinhaPdf, colunas: Colunas): CelulaPdf | undefined {
  return linha.celulas.find((c) => c.x > colunas.indice + 10 && c.x < colunas.quantidade - 80);
}

/**
 * O texto INTEIRO da coluna do SKU. A descrição do produto vem partida em
 * várias células ("Bau" + "T" + "raseiro Plástico 45L"), e ficar com a primeira
 * devolvia "Bau" como nome do produto.
 */
function textoDaColunaDoSku(linha: LinhaPdf, colunas: Colunas): string {
  return linha.celulas
    .filter((c) => c.x > colunas.indice + 10 && c.x < colunas.quantidade - 80)
    .map((c) => c.texto)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** A quantidade vem depois do "×" — o multiplicador que o UpSeller imprime. */
function quantidadeDaLinha(linha: LinhaPdf, colunas: Colunas): number | null {
  for (const celula of linha.celulas.filter((c) => c.x >= colunas.quantidade - 40)) {
    const valor = numeroBr(celula.texto.replace(/[×x]/gi, ""));

    if (valor !== null && valor > 0) return valor;
  }

  return null;
}

export function lerSaidaUpseller(linhas: readonly LinhaPdf[]): LeituraDocumento {
  if (linhas.length === 0) {
    return { ok: false, motivo: "não foi possível ler texto neste PDF — ele pode ser uma imagem digitalizada" };
  }

  const texto = linhas.map((l) => l.texto).join("\n");

  if (!/Pedido de Sa[íi]da/i.test(texto)) {
    return { ok: false, motivo: "este PDF não parece um Pedido de Saída do UpSeller" };
  }

  const cabecalho = acharColunas(linhas);

  if (cabecalho === null) {
    return { ok: false, motivo: "não foi possível achar a tabela de itens (# / SKU / Qtd.) no pedido de saída" };
  }

  const { colunas } = cabecalho;
  const itens: ItemLido[] = [];

  for (const linha of linhas.slice(cabecalho.linha + 1)) {
    if (/^Total/i.test(linha.texto.trim())) break;

    const indice = linha.celulas.find((c) => Math.abs(c.x - colunas.indice) <= 12);
    const sku = naColunaDoSku(linha, colunas);

    // Linha de item: índice numérico na primeira coluna e SKU na segunda.
    if (indice !== undefined && /^\d+$/.test(indice.texto.trim()) && sku !== undefined) {
      const quantidade = quantidadeDaLinha(linha, colunas);

      if (quantidade === null) continue;

      itens.push({
        posicao: itens.length + 1,
        codigo: sku.texto.trim(),
        descricao: "",
        quantidade,
        unidade: null,
        ean: null,
        ncm: null,
        cfop: null,
        valorUnitario: null,
        valorTotal: null,
      });

      continue;
    }

    // Linha seguinte, na coluna do SKU e sem índice: é a descrição do item.
    const ultimo = itens.at(-1);

    if (ultimo?.descricao === "" && sku !== undefined) {
      itens[itens.length - 1] = { ...ultimo, descricao: textoDaColunaDoSku(linha, colunas) };
    }
  }

  if (itens.length === 0) {
    return { ok: false, motivo: "o pedido de saída foi lido, mas nenhum item foi reconhecido" };
  }

  const numero = /N[º°ºo]\s*da\s*Sa[íi]da:\s*([A-Z0-9-]+)/i.exec(texto)?.[1] ?? null;
  /*
    O armazém vem na MESMA linha, e a leitura para em "Operador:" quando ele
    existe. `[^]` (qualquer caractere, inclusive quebra) somado a `$` sem `m`
    fazia um pedido SEM operador engolir o documento inteiro como nome de
    armazém — medido num pedido sintético, depois de o arquivo real ter passado
    só porque tinha operador.
  */
  const armazem = /Armaz[ée]m:[ \t]*([^\r\n]*?)(?:Operador:|$)/im.exec(texto)?.[1]?.trim() ?? null;
  const observacao = linhas[linhas.findIndex((l) => /^Observa[çc][ãa]o$/i.test(l.texto.trim())) + 1]?.texto.trim();
  const impressao = /Imprimir:\s*(\d{2})\/(\d{2})\/(\d{4})\s*(\d{2}):(\d{2})/.exec(texto);
  const emitidoEm =
    impressao === null
      ? null
      : // Horário de Brasília na impressão; guardado como instante.
        `${impressao[3] ?? ""}-${impressao[2] ?? ""}-${impressao[1] ?? ""}T${impressao[4] ?? ""}:${impressao[5] ?? ""}:00.000-03:00`;

  const documento: DocumentoLido = {
    tipo: "SAIDA_UPSELLER_PDF",
    // Pedido de saída é saída por definição — o próprio título diz.
    direcao: "SAIDA",
    numero,
    serie: null,
    chave: null,
    emitidoEm,
    emitenteCnpj: null,
    emitenteNome: null,
    referencia: [armazem === null ? null : `Armazém ${armazem}`, observacao === undefined || observacao === "" ? null : observacao]
      .filter((parte): parte is string => parte !== null)
      .join(" · "),
    itens: itens.map((item) => ({ ...item, descricao: item.descricao === "" ? item.codigo : item.descricao })),
  };

  return { ok: true, valor: documento };
}
