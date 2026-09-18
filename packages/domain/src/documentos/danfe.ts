import { digitos, mesmaEmpresa, numeroBr, type DocumentoLido, type ItemLido, type LeituraDocumento, type LinhaPdf } from "./tipos.js";

/**
 * O DANFE em PDF (D-375) — o papel da NF-e.
 *
 * **Só entra quando o XML não veio.** O XML é conferido pela SEFAZ e traz tudo
 * estruturado; o DANFE é uma REPRESENTAÇÃO impressa, e ler número de uma
 * impressão é sempre menos seguro. A tela de conferência continua sendo quem
 * decide, e ela mostra de qual arquivo cada campo saiu.
 *
 * **As colunas saem do cabeçalho, não de posição fixa.** A tabela de itens do
 * DANFE tem rótulos padronizados pelo Manual do Contribuinte ("CÓDIGO PRODUTO",
 * "QUANT", "VALOR UNIT"), mas cada emissor desenha em coordenadas próprias.
 * Este leitor acha o `x` de cada rótulo no cabeçalho e depois classifica cada
 * célula pela coluna mais próxima — assim um DANFE de outro emissor, com a
 * mesma tabela em outra largura, continua sendo lido.
 *
 * **A direção sai do CNPJ da própria empresa**, como no XML (D-053): emitente
 * igual ao nosso é SAÍDA; destinatário igual ao nosso é ENTRADA. Nunca do
 * quadrinho "0 - ENTRADA / 1 - SAÍDA", que é a direção do ponto de vista de
 * quem emitiu.
 */

interface Coluna {
  readonly chave: "codigo" | "descricao" | "unidade" | "quantidade" | "valorUnitario" | "valorTotal" | "ncm" | "cfop";
  readonly x: number;
}

const ROTULOS: readonly { readonly chave: Coluna["chave"]; readonly padrao: RegExp }[] = [
  { chave: "codigo", padrao: /^C[ÓO]DIGO/i },
  { chave: "descricao", padrao: /^DESCRI[ÇC][ÃA]O/i },
  { chave: "ncm", padrao: /^NCM/i },
  { chave: "cfop", padrao: /^CFOP/i },
  { chave: "unidade", padrao: /^UN$|^UNID/i },
  { chave: "quantidade", padrao: /^QUANT/i },
];

/**
 * O cabeçalho da tabela de itens de UMA página, com o `x` de cada coluna.
 *
 * Por página, e não uma vez só: o DANFE repete o cabeçalho em cada folha, e os
 * itens do fornecedor de exemplo seguiam em três. Varrer tudo de uma vez
 * pararia no rodapé da primeira folha ("DADOS ADICIONAIS") e perderia 32 dos
 * 44 itens — medido.
 */
function acharColunas(linhas: readonly LinhaPdf[]): { colunas: Coluna[]; indice: number } | null {
  for (const [indice, linha] of linhas.entries()) {
    const achadas: Coluna[] = [];

    for (const celula of linha.celulas) {
      const rotulo = ROTULOS.find((r) => r.padrao.test(celula.texto.trim()));

      if (rotulo !== undefined && !achadas.some((a) => a.chave === rotulo.chave)) {
        achadas.push({ chave: rotulo.chave, x: celula.x });
      }
    }

    // "CÓDIGO", "DESCRIÇÃO", "QUANT" e "UN" na mesma linha só acontece no
    // cabeçalho da tabela de produtos.
    if (achadas.some((a) => a.chave === "codigo") && achadas.some((a) => a.chave === "quantidade")) {
      /*
        VALOR UNIT e VALOR TOTAL vêm em DUAS linhas ("VALOR" em cima, "UNIT"
        embaixo), e a ordem das três no arquivo varia por emissor — no primeiro
        DANFE real a linha do "UNIT" vinha DEPOIS; noutro pode vir antes. Por
        isso a busca é na vizinhança, não na linha seguinte.
      */
      for (const vizinha of linhas.slice(Math.max(0, indice - 2), indice + 3)) {
        for (const celula of vizinha.celulas) {
          const texto = celula.texto.trim().toUpperCase();

          if (texto === "UNIT" && !achadas.some((a) => a.chave === "valorUnitario")) {
            achadas.push({ chave: "valorUnitario", x: celula.x });
          }

          if (texto === "TOTAL" && !achadas.some((a) => a.chave === "valorTotal")) {
            achadas.push({ chave: "valorTotal", x: celula.x });
          }
        }
      }

      return { colunas: achadas, indice };
    }
  }

  return null;
}

function colunaDe(colunas: readonly Coluna[], x: number): Coluna["chave"] | null {
  let melhor: Coluna | null = null;

  for (const coluna of colunas) {
    if (melhor === null || Math.abs(coluna.x - x) < Math.abs(melhor.x - x)) melhor = coluna;
  }

  // Célula muito longe de qualquer coluna conhecida (impostos à direita) fica de fora.
  return melhor !== null && Math.abs(melhor.x - x) <= 40 ? melhor.chave : null;
}

const FIM_DA_TABELA = /C[ÁA]LCULO DO ISSQN|DADOS ADICIONAIS|INFORMA[ÇC][ÕO]ES COMPLEMENTARES|RESERVADO AO FISCO/i;

function lerItens(linhas: readonly LinhaPdf[], inicio: number, colunas: readonly Coluna[]): ItemLido[] {
  const itens: ItemLido[] = [];

  for (const linha of linhas.slice(inicio)) {
    if (FIM_DA_TABELA.test(linha.texto)) break;

    const campos = new Map<Coluna["chave"], string>();

    for (const celula of linha.celulas) {
      const chave = colunaDe(colunas, celula.x);

      if (chave === null) continue;

      const anterior = campos.get(chave);

      campos.set(chave, anterior === undefined ? celula.texto.trim() : `${anterior} ${celula.texto.trim()}`);
    }

    const codigo = campos.get("codigo");
    const quantidade = numeroBr(campos.get("quantidade"));

    if (codigo === undefined || quantidade === null || quantidade <= 0) {
      // Linha de continuação da descrição: pertence ao item anterior.
      const descricao = campos.get("descricao");
      const ultimo = itens.at(-1);

      if (descricao !== undefined && ultimo !== undefined && campos.size === 1) {
        itens[itens.length - 1] = { ...ultimo, descricao: `${ultimo.descricao} ${descricao}`.trim() };
      }

      continue;
    }

    itens.push({
      posicao: itens.length + 1,
      codigo,
      descricao: campos.get("descricao") ?? codigo,
      quantidade,
      unidade: campos.get("unidade") ?? null,
      ean: null,
      ncm: campos.get("ncm") ?? null,
      cfop: campos.get("cfop") ?? null,
      valorUnitario: numeroBr(campos.get("valorUnitario")),
      valorTotal: numeroBr(campos.get("valorTotal")),
    });
  }

  return itens;
}

/**
 * A chave é impressa em ONZE blocos de quatro ("4226 0727 8109 ..."). Aceitar
 * "44 dígitos seguidos, com ou sem espaço" pegava o protocolo de autorização
 * colado na data ao lado e devolvia uma chave que não existia — medido no
 * primeiro DANFE real.
 */
function acharChave(texto: string): string | null {
  for (const candidato of texto.matchAll(/\b(?:\d{4}[ .]){10}\d{4}\b/g)) {
    const limpo = digitos(candidato[0]);

    if (limpo.length === 44) return limpo;
  }

  return null;
}

/**
 * CNPJ COM pontuação, sempre: o DANFE imprime "27.810.945/0002-06", e aceitar
 * 14 dígitos soltos fazia o protocolo de autorização (15 dígitos seguidos)
 * virar "CNPJ do emitente" — medido no primeiro DANFE real.
 */
function acharCnpjs(linhas: readonly LinhaPdf[]): string[] {
  const achados: string[] = [];

  for (const linha of linhas) {
    for (const candidato of linha.texto.matchAll(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g)) {
      const limpo = digitos(candidato[0]);

      if (limpo.length === 14 && !achados.includes(limpo)) achados.push(limpo);
    }
  }

  return achados;
}

/** O nome logo abaixo de "IDENTIFICAÇÃO DO EMITENTE" — é assim que o DANFE o imprime. */
function acharEmitenteNome(linhas: readonly LinhaPdf[]): string | null {
  const indice = linhas.findIndex((l) => /IDENTIFICA[ÇC][ÃA]O DO EMITENTE/i.test(l.texto));

  if (indice === -1) return null;

  const nome = linhas[indice + 1]?.texto.trim();

  return nome === undefined || nome === "" ? null : nome;
}

function acharData(texto: string): string | null {
  const data = /(\d{2})\/(\d{2})\/(\d{4})/.exec(texto);
  const dia = data?.[1];
  const mes = data?.[2];
  const ano = data?.[3];

  if (dia === undefined || mes === undefined || ano === undefined) return null;

  // Meio-dia UTC: o DANFE traz a data civil, e a hora não decide nada aqui.
  return `${ano}-${mes}-${dia}T12:00:00.000Z`;
}

/**
 * Lê um DANFE já convertido em linhas posicionadas. `cnpjProprio` é o CNPJ da
 * organização — é ele que decide a direção.
 */
export function lerDanfe(linhas: readonly LinhaPdf[], cnpjProprio: string): LeituraDocumento {
  if (linhas.length === 0) {
    return { ok: false, motivo: "não foi possível ler texto neste PDF — ele pode ser uma imagem digitalizada" };
  }

  const texto = linhas.map((l) => l.texto).join("\n");

  if (!/DANFE|DOCUMENTO AUXILIAR DA NOTA FISCAL/i.test(texto)) {
    return { ok: false, motivo: "este PDF não parece um DANFE" };
  }

  const paginas = new Map<number, LinhaPdf[]>();

  for (const linha of linhas) {
    paginas.set(linha.pagina, [...(paginas.get(linha.pagina) ?? []), linha]);
  }

  const itens: ItemLido[] = [];

  for (const daPagina of paginas.values()) {
    const cabecalho = acharColunas(daPagina);

    if (cabecalho === null) continue;

    for (const item of lerItens(daPagina, cabecalho.indice + 1, cabecalho.colunas)) {
      itens.push({ ...item, posicao: itens.length + 1 });
    }
  }

  if (itens.length === 0) {
    return { ok: false, motivo: "o DANFE foi lido, mas nenhum item foi reconhecido na tabela de produtos" };
  }

  const cnpjs = acharCnpjs(linhas);
  const emitente = cnpjs[0] ?? null;
  // Pela RAIZ do CNPJ: matriz e filial são o mesmo estoque (`mesmaEmpresa`).
  const daCasa = (cnpj: string | null): boolean => mesmaEmpresa(cnpj, cnpjProprio);

  if (!cnpjs.some(daCasa)) {
    return {
      ok: false,
      motivo: "o CNPJ da organização não aparece neste DANFE — sem ele não dá para decidir entrada ou saída",
    };
  }

  // Um CNPJ da casa DEPOIS do emitente é o destinatário: entrada — inclusive
  // na transferência entre matriz e filial, em que o emitente também é da casa
  // (decisão do dono, 18/09/2026). Senão, o CNPJ da casa que achamos acima é o
  // do emitente: saída (D-053).
  const direcao = cnpjs.slice(1).some(daCasa) ? "ENTRADA" : "SAIDA";
  // "Nº. 000.000.022" -> "22": o zero à esquerda é enfeite de impressão.
  const numeroBruto = /N[º°ºo]?\.?\s*([\d.]{3,})/i.exec(texto)?.[1]?.replace(/\./g, "") ?? null;
  const numero = numeroBruto === null ? null : (numeroBruto.replace(/^0+/, "") || numeroBruto);
  const serie = /S[ÉE]RIE\s*:?\s*(\d{1,3})/i.exec(texto)?.[1] ?? null;

  const documento: DocumentoLido = {
    tipo: "DANFE_PDF",
    direcao,
    numero,
    serie,
    chave: acharChave(texto),
    emitidoEm: acharData(texto),
    emitenteCnpj: emitente,
    emitenteNome: acharEmitenteNome(linhas),
    referencia: null,
    itens,
  };

  return { ok: true, valor: documento };
}
