import { indiceDaColuna, type Aba, type Celula } from "./xlsx";

/**
 * Invoice, proforma e "sales confirmation" de fornecedor (D-767): uma LINHA
 * por item, ao contrário do controle de chegada, que tem uma COLUNA por
 * pedido.
 *
 * Esses documentos raramente dão nome às colunas ("Quantities and
 * Descriptions" cobre NCM, pedido, SKU, descrição e quantidade de uma vez).
 * Por isso a leitura não depende do cabeçalho: ela procura as três colunas
 * numéricas em que, linha após linha, quantidade × preço unitário = valor —
 * a assinatura de qualquer invoice. Achada a trinca, as outras colunas são
 * reconhecidas pelo conteúdo das linhas de item: 8 dígitos é NCM, "PCS/SETS/
 * PRS" é unidade, código repetido que aparece no "S/C NO." do cabeçalho é o
 * pedido, código curto e único é o SKU, o texto mais longo é a descrição.
 *
 * Nada é inventado: sem "$"/USD no documento, a moeda fica desconhecida; data
 * que não dá para ler sem ambiguidade fica só como texto; linha sem pedido
 * herda o pedido do cabeçalho apenas quando o cabeçalho tem UM pedido.
 */

export type TipoDocumento = "COMERCIAL" | "PROFORMA";

export interface DocumentoFornecedor {
  readonly tipo: TipoDocumento | null;
  /** Número do documento ("NO." / "No."): a invoice, não necessariamente o pedido. */
  readonly numero: string | null;
  /** A data como estava escrita e, quando dá para ler sem ambiguidade, em ISO. */
  readonly data: string | null;
  readonly dataIso: string | null;
  /** Os pedidos do "S/C NO." (contrato de venda = número do pedido no fornecedor). */
  readonly pedidos: readonly string[];
  readonly bl: string | null;
  readonly container: string | null;
  /** "Delivery:" da proforma: a previsão que o fornecedor deu. */
  readonly entrega: string | null;
  readonly entregaIso: string | null;
  /** "USD" só quando o documento mostra $ ou USD; senão desconhecida. */
  readonly moeda: string | null;
}

export interface LayoutLista {
  /** A linha de títulos mais próxima acima do primeiro item (só para exibir). */
  readonly linhaCabecalho: number;
  /** As linhas de item, na ordem. */
  readonly itens: readonly number[];
  readonly quantidade: string;
  readonly preco: string;
  readonly valor: string | null;
  readonly ncm: string | null;
  readonly referencia: string | null;
  readonly codigo: string | null;
  readonly descricao: string | null;
  readonly unidade: string | null;
  /** Texto curto que não é nada acima (tamanho, cor, marca): vira observação. */
  readonly observacoes: readonly string[];
  readonly documento: DocumentoFornecedor;
  /** O TOTAL que o próprio documento imprime na coluna de valor (null = não tem). */
  readonly totalDocumento: number | null;
}

/** Texto da célula numa linha só, sem as quebras que as proformas põem em tudo. */
export function textoLimpo(c: Celula | undefined): string {
  return (c?.texto ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

/**
 * Número como as invoices escrevem: "1.06", "71,442.00", "$10.60", "$ 16.60",
 * "243.00\r\n". Formato americano (vírgula de milhar, ponto decimal) — é o das
 * invoices em dólar. Texto que não é número → null.
 */
export function numeroDeInvoice(texto: string): number | null {
  let t = texto.replace(/[\r\n\t]/g, " ").trim().replace(/^(US\s*\$|USD|\$)\s*/i, "").trim();

  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;

  const n = Number(t);

  return Number.isFinite(n) ? n : null;
}

const MOEDA_SOLTA = /^(US\s*\$|USD|\$)$/i;
const NCM = /^\d{4}\.?\d{2}\.?\d{2}$/;
const UNIDADE = /^(pcs?|pc|sets?|prs?|pairs?|pares?|par|un|und|unid|kgs?|ctns?|cartons?|boxes|box|rolls?|m)\.?$/i;
/** Código de pedido: letras e ao menos três dígitos ("JS31205", "JSD01080", "A2026C701A", "PO-1001"). */
const CODIGO_DE_PEDIDO = /^(?=.*[A-Z])(?=.*\d{3})[A-Z0-9][A-Z0-9\-/.]{3,39}$/i;
const PALAVRA_DE_TITULO = /\b(qty|quantit|quantidade|price|pre[çc]o|amount|valor|description|descri[çc][ãa]o|total|model|modelo|item)/i;

function bate(q: number, p: number, a: number): boolean {
  return a > 0 && Math.abs(q * p - a) <= Math.max(0.011, a * 0.005);
}

function dataIso(ano: number, mes: number, dia: number): string | null {
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || ano < 2000 || ano > 2100) return null;

  const d = new Date(Date.UTC(ano, mes - 1, dia));

  return d.getUTCMonth() === mes - 1 ? d.toISOString().slice(0, 10) : null;
}

const MESES: Record<string, number> = {
  jan: 1, feb: 2, fev: 2, mar: 3, apr: 4, abr: 4, may: 5, mai: 5, jun: 6, jul: 7,
  aug: 8, ago: 8, sep: 9, sept: 9, set: 9, oct: 10, out: 10, nov: 11, dec: 12, dez: 12,
};

/**
 * "Sep 28,2026", "26 Oct,2026", "30.NOV.2026", "30/10/2026", "2026-10-30".
 * Dia e mês só com número e os dois ≤ 12 ("03/04/2026") é ambíguo: null.
 */
export function lerData(texto: string): string | null {
  const t = texto.trim().toLowerCase();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);

  if (m !== null) return dataIso(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^([a-z]{3,4})\.?\s*(\d{1,2})\s*,?\s*(\d{4})$/.exec(t);
  if (m !== null && MESES[m[1] ?? ""] !== undefined) return dataIso(Number(m[3]), MESES[m[1] ?? ""] ?? 0, Number(m[2]));

  m = /^(\d{1,2})[\s.\-/]*([a-z]{3,4})[\s.\-/,]*(\d{4})$/.exec(t);
  if (m !== null && MESES[m[2] ?? ""] !== undefined) return dataIso(Number(m[3]), MESES[m[2] ?? ""] ?? 0, Number(m[1]));

  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(t);
  if (m !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);

    if (a > 12 && b <= 12) return dataIso(Number(m[3]), b, a);
    if (b > 12 && a <= 12) return dataIso(Number(m[3]), a, b);
    if (a === b) return dataIso(Number(m[3]), a, b);

    return null;
  }

  return null;
}

function linhasOrdenadas(aba: Aba): [number, ReadonlyMap<string, Celula>][] {
  return [...aba.grade].sort((a, b) => a[0] - b[0]);
}

/** O valor depois do rótulo: na mesma célula ("B/L NO.：X") ou na próxima célula preenchida à direita. */
function valorDoRotulo(linha: ReadonlyMap<string, Celula>, coluna: string, resto: string): string | null {
  const direto = resto.replace(/^[\s:：]+/, "").trim();

  if (direto !== "") return direto;

  const i = indiceDaColuna(coluna);
  const depois = [...linha.entries()]
    .filter(([c]) => indiceDaColuna(c) > i)
    .sort((a, b) => indiceDaColuna(a[0]) - indiceDaColuna(b[0]));

  for (const [, c] of depois) {
    const t = textoLimpo(c).replace(/^[\s:：]+/, "").replace(/[\s/]+$/, "").trim();

    if (t !== "") return t;
  }

  return null;
}

export function lerDocumento(aba: Aba, ateLinha: number, nomeArquivo = ""): DocumentoFornecedor {
  let numero: string | null = null;
  let data: string | null = null;
  let pedidos: string[] = [];
  let bl: string | null = null;
  let container: string | null = null;
  let entrega: string | null = null;
  let tipo: TipoDocumento | null = /proforma|^pi[-_ ]/i.test(nomeArquivo) ? "PROFORMA" : null;
  let moeda: string | null = null;

  for (const [n, linha] of linhasOrdenadas(aba)) {
    for (const [coluna, celula] of linha) {
      const t = textoLimpo(celula);

      if (t === "") continue;
      if (/\b(us\s*\$|usd)\b|\$/i.test(t)) moeda = "USD";
      if (/commercial\s+invoice/i.test(t)) tipo = "COMERCIAL";
      else if (tipo === null && /proforma|sales\s+confirmation/i.test(t)) tipo = "PROFORMA";

      if (n >= ateLinha) continue;

      let m = /^(?:invoice\s+)?no\.?(\s*[:：].*)?$/i.exec(t);

      if (m !== null && numero === null) {
        numero = valorDoRotulo(linha, coluna, m[1] ?? "");
        continue;
      }

      m = /^(?:invoice\s+)?date\s*([:：].*)?$/i.exec(t);
      if (m !== null && data === null) {
        data = valorDoRotulo(linha, coluna, m[1] ?? "");
        continue;
      }

      m = /^s\s*\/\s*c\s*no\.?\s*([:：].*)?$/i.exec(t);
      if (m !== null && pedidos.length === 0) {
        const v = valorDoRotulo(linha, coluna, m[1] ?? "") ?? "";

        pedidos = v.split(/[\s,;/]+/).filter((p) => CODIGO_DE_PEDIDO.test(p));
        continue;
      }

      m = /^b\s*\/\s*l\s*no\.?\s*([:：].*)?$/i.exec(t);
      if (m !== null && bl === null) {
        bl = valorDoRotulo(linha, coluna, m[1] ?? "");
        continue;
      }

      m = /^container(?:\s*\/\s*seal)?\s*no\.?\s*([:：].*)?$/i.exec(t);
      if (m !== null && container === null) {
        container = (valorDoRotulo(linha, coluna, m[1] ?? "") ?? "").split("/")[0]?.trim() ?? "";
        if (container === "") container = null;
        continue;
      }

      m = /^delivery\s*([:：].*)?$/i.exec(t);
      if (m !== null && entrega === null) entrega = valorDoRotulo(linha, coluna, m[1] ?? "");
    }
  }

  const corta = (v: string | null, max: number): string | null => (v === null || v === "" ? null : v.slice(0, max));

  return {
    tipo,
    numero: corta(numero, 80),
    data: corta(data, 40),
    dataIso: data === null ? null : lerData(data),
    pedidos: [...new Set(pedidos.map((p) => p.toUpperCase()))],
    bl: corta(bl, 60),
    container: corta(container, 40),
    entrega: corta(entrega, 40),
    entregaIso: entrega === null ? null : lerData(entrega),
    moeda,
  };
}

interface Trinca {
  a: string;
  b: string;
  valor: string;
  apoio: number;
}

/**
 * A trinca (x, y, valor) com x × y = valor no maior número de linhas. O valor
 * fica à direita dos dois fatores; x e y são simétricos e o preço é decidido
 * depois. Trinca trivial (um fator 1, ou o valor igual a um fator) não conta.
 */
function acharTrinca(aba: Aba): Trinca | null {
  const apoio = new Map<string, Trinca>();

  for (const [, linha] of aba.grade) {
    const nums: [string, number][] = [];

    for (const [col, c] of linha) {
      const v = numeroDeInvoice(c.texto);

      if (v !== null && v > 0) nums.push([col, v]);
    }

    if (nums.length < 3 || nums.length > 30) continue;
    nums.sort((p, q) => indiceDaColuna(p[0]) - indiceDaColuna(q[0]));

    for (let k = 2; k < nums.length; k += 1) {
      const [colA, a] = nums[k] ?? ["", 0];

      for (let i = 0; i < k; i += 1) {
        for (let j = i + 1; j < k; j += 1) {
          const [colX, x] = nums[i] ?? ["", 0];
          const [colY, y] = nums[j] ?? ["", 0];

          if (x === 1 || y === 1 || a === x || a === y || !bate(x, y, a)) continue;

          const chave = `${colX}|${colY}|${colA}`;
          const t = apoio.get(chave) ?? { a: colX, b: colY, valor: colA, apoio: 0 };

          t.apoio += 1;
          apoio.set(chave, t);
        }
      }
    }
  }

  let melhor: Trinca | null = null;

  for (const t of apoio.values()) if (melhor === null || t.apoio > melhor.apoio) melhor = t;

  return melhor !== null && melhor.apoio >= 2 ? melhor : null;
}

function proporcao<T>(xs: readonly T[], f: (x: T) => boolean): number {
  return xs.length === 0 ? 0 : xs.filter(f).length / xs.length;
}

/**
 * O layout de lista, quando a aba é uma invoice. `null` = não é (o controle de
 * chegada e o catálogo seguem pela classificação por coluna).
 */
export function detectarLista(aba: Aba, nomeArquivo = ""): LayoutLista | null {
  const trinca = acharTrinca(aba);

  if (trinca === null) return null;

  const num = (linha: ReadonlyMap<string, Celula>, col: string): number | null => {
    const c = linha.get(col);

    return c === undefined ? null : numeroDeInvoice(c.texto);
  };

  // Qual fator é o preço: o título diz ("Quantity", "Unit Price"); sem título,
  // o que tem mais casas decimais; empate, o menor valor.
  const comTrinca = linhasOrdenadas(aba).filter(([, l]) => num(l, trinca.a) !== null && num(l, trinca.b) !== null);
  const linhasComTrinca = comTrinca.map(([, l]) => l);
  const primeiraComTrinca = comTrinca[0]?.[0] ?? 1;
  const titulo = (col: string): string =>
    linhasOrdenadas(aba)
      .filter(([n]) => n < primeiraComTrinca && n >= primeiraComTrinca - 12)
      .map(([, l]) => textoLimpo(l.get(col)))
      .join(" ");
  const ehQtd = (col: string): boolean => /\b(qty|quantit\w*|quantidade|qtde?)\b/i.test(titulo(col));
  const ehPreco = (col: string): boolean => /\b(price|pre[çc]o|unit\w*\s+cost)\b/i.test(titulo(col));
  const fracao = (col: string): number => proporcao(linhasComTrinca, (l) => !Number.isInteger(num(l, col) ?? 0));
  const media = (col: string): number => linhasComTrinca.reduce((s, l) => s + (num(l, col) ?? 0), 0) / Math.max(1, linhasComTrinca.length);
  const precoEhA =
    ehQtd(trinca.b) !== ehQtd(trinca.a)
      ? ehQtd(trinca.b)
      : ehPreco(trinca.a) !== ehPreco(trinca.b)
        ? ehPreco(trinca.a)
        : fracao(trinca.a) > fracao(trinca.b) || (fracao(trinca.a) === fracao(trinca.b) && media(trinca.a) < media(trinca.b));
  const preco = precoEhA ? trinca.a : trinca.b;
  const quantidade = precoEhA ? trinca.b : trinca.a;

  // Linha de item: quantidade e preço numéricos, e não é a linha de total.
  const itens = linhasOrdenadas(aba)
    .filter(([, l]) => {
      const q = num(l, quantidade);
      const p = num(l, preco);

      return q !== null && q > 0 && p !== null && ![...l.values()].some((c) => /^\s*(sub)?total\b/i.test(c.texto));
    })
    .map(([n]) => n);

  if (itens.length === 0) return null;

  const primeiro = itens[0] ?? 1;
  const doItem = itens.map((n) => aba.grade.get(n) ?? new Map<string, Celula>());
  const usadas = new Set([quantidade, preco, trinca.valor]);
  const colunas = new Set<string>();

  for (const l of doItem) for (const c of l.keys()) if (!usadas.has(c)) colunas.add(c);

  const ordenadas = [...colunas].sort((a, b) => indiceDaColuna(a) - indiceDaColuna(b));
  const valores = (col: string): string[] => doItem.map((l) => textoLimpo(l.get(col))).filter((t) => t !== "");
  const documento = lerDocumento(aba, primeiro, nomeArquivo);
  let ncm: string | null = null;
  let unidade: string | null = null;
  let referencia: string | null = null;
  const texto: string[] = [];

  for (const col of ordenadas) {
    const vs = valores(col);

    if (vs.length === 0 || vs.every((v) => MOEDA_SOLTA.test(v))) continue;

    if (ncm === null && proporcao(vs, (v) => NCM.test(v)) >= 0.8) {
      ncm = col;
    } else if (unidade === null && proporcao(vs, (v) => UNIDADE.test(v)) >= 0.8) {
      unidade = col;
    } else if (
      referencia === null &&
      proporcao(vs, (v) => CODIGO_DE_PEDIDO.test(v)) >= 0.8 &&
      (vs.some((v) => documento.pedidos.includes(v.toUpperCase())) || new Set(vs).size <= Math.max(1, Math.floor(vs.length / 3)))
    ) {
      referencia = col;
    } else if (proporcao(vs, (v) => numeroDeInvoice(v) !== null) < 0.5) {
      texto.push(col);
    }
  }

  // Código: palavra única e curta, com dígito. Descrição: o texto mais longo.
  const tamanho = (col: string): number => {
    const vs = valores(col);

    return vs.reduce((s, v) => s + v.length, 0) / Math.max(1, vs.length);
  };
  const codigo =
    texto
      .filter((col) => {
        const vs = valores(col);

        // SKU tem dígito ("TST01"); "Black" é cor, não código. O mesmo SKU pode
        // vir partido em várias linhas, então repetir não desqualifica.
        return proporcao(vs, (v) => !/\s/.test(v) && v.length <= 40) >= 0.8 && proporcao(vs, (v) => /\d/.test(v)) >= 0.5;
      })
      // Entre os candidatos, o mais variado linha a linha; depois o mais preenchido.
      .sort((a, b) => new Set(valores(b)).size - new Set(valores(a)).size || valores(b).length - valores(a).length)[0] ?? null;
  const descricao =
    texto.filter((c) => c !== codigo && tamanho(c) >= 8).sort((a, b) => tamanho(b) - tamanho(a))[0] ?? null;
  const observacoes = texto.filter((c) => c !== codigo && c !== descricao);

  // O TOTAL impresso: a linha de total depois dos itens, na coluna de valor.
  let totalDocumento: number | null = null;

  for (const [n, l] of linhasOrdenadas(aba)) {
    if (n <= primeiro || ![...l.values()].some((c) => /^\s*total\b/i.test(c.texto))) continue;
    const v = num(l, trinca.valor);

    if (v !== null) {
      totalDocumento = v;
      break;
    }
  }

  // Títulos: a linha acima do primeiro item com palavras de título (só para mostrar).
  let linhaCabecalho = primeiro - 1;

  for (const [n, l] of linhasOrdenadas(aba).filter(([n]) => n < primeiro && n >= primeiro - 12).reverse()) {
    const textos = [...l.values()].filter((c) => !c.numerica && textoLimpo(c) !== "");

    if (textos.length >= 3 && textos.some((c) => PALAVRA_DE_TITULO.test(c.texto))) {
      linhaCabecalho = n;
      break;
    }
  }

  return {
    linhaCabecalho: Math.max(1, linhaCabecalho),
    itens,
    quantidade,
    preco,
    valor: trinca.valor,
    ncm,
    referencia,
    codigo,
    descricao,
    unidade,
    observacoes,
    documento,
    totalDocumento,
  };
}

/**
 * A referência das linhas que não trazem o pedido: o único pedido do "S/C
 * NO."; sem S/C, o número do documento (a proforma É o pedido); sem nada, o
 * nome do arquivo quando ele tem cara de código ("A2026C701A-.xlsx").
 * Vários pedidos no cabeçalho e linha sem pedido: null — o usuário informa.
 */
export function referenciaPadrao(doc: DocumentoFornecedor, nomeArquivo: string): string | null {
  if (doc.pedidos.length === 1) return doc.pedidos[0] ?? null;
  if (doc.pedidos.length > 1) return null;
  if (doc.numero !== null && CODIGO_DE_PEDIDO.test(doc.numero)) return doc.numero;

  const base = nomeArquivo.replace(/\.[a-z0-9]+$/i, "").replace(/^(pi|proforma)[-_ ]+/i, "").replace(/(inv)?(&|_)?(pl)?[-_ ]*$/i, "");

  return CODIGO_DE_PEDIDO.test(base) ? base.toUpperCase() : null;
}

/** A observação de documento que vai em cada linha: de onde a quantidade veio. */
export function resumoDoDocumento(doc: DocumentoFornecedor): string | null {
  const partes: string[] = [];
  const nome = doc.tipo === "PROFORMA" ? "Proforma" : "Invoice";

  if (doc.numero !== null) partes.push(`${nome} ${doc.numero}${doc.data === null ? "" : ` de ${doc.data}`}`);
  else if (doc.data !== null) partes.push(`${nome} de ${doc.data}`);
  if (doc.bl !== null) partes.push(`B/L ${doc.bl}`);
  if (doc.container !== null) partes.push(`contêiner ${doc.container}`);
  if (doc.entrega !== null) partes.push(`entrega prevista ${doc.entrega}`);

  return partes.length === 0 ? null : partes.join(" · ");
}
