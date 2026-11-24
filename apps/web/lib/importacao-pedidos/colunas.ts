import { detectarLista, ehMoedaSolta, numeroDeInvoice, referenciaPadrao, resumoDoDocumento, textoLimpo, type DocumentoFornecedor } from "./invoice";
import { colunaDe, indiceDaColuna, type Aba, type Celula } from "./xlsx";

/**
 * Da grade da aba às linhas da importação (D-764): que coluna é o quê, e o que
 * cada quantidade diz. Tudo aqui é SUGESTÃO para a tela de classificação — o
 * usuário confirma ou troca antes de qualquer coisa ser enviada.
 *
 * - Cabeçalho reconhecido por palavra (código, EAN, NCM, descrição, obs.).
 * - Coluna numérica com cabeçalho que parece referência de pedido ("30632-1",
 *   "31011", "JS31205") vira quantidade daquela referência.
 * - Coluna numérica SEM cabeçalho vira quantidade com referência a informar:
 *   o número do pedido nunca é inventado.
 * - Valor, preço, custo, FOB, peso, caixa: ignorados (são números, não
 *   quantidade encomendada).
 */

export type PapelColuna =
  | "CODIGO"
  | "EAN"
  | "NCM"
  | "DESCRICAO"
  | "OBSERVACAO"
  | "QUANTIDADE"
  | "REFERENCIA"
  | "PRECO"
  | "VALOR"
  | "UNIDADE"
  | "IGNORAR";

export interface ColunaClassificada {
  readonly coluna: string;
  readonly cabecalho: string;
  papel: PapelColuna;
  /** Só na QUANTIDADE: a referência do pedido desta coluna. `null` = a informar. */
  referencia: string | null;
  /** Quantas linhas abaixo do cabeçalho têm valor nesta coluna. */
  readonly preenchidas: number;
  readonly numericas: number;
}

export interface ClassificacaoAba {
  readonly aba: string;
  linhaCabecalho: number;
  colunas: ColunaClassificada[];
  /**
   * Invoice/proforma (D-767): uma linha por item. As linhas de item já
   * escolhidas, o cabeçalho do documento e a referência das linhas sem pedido
   * (editável). Ausente = layout de matriz (uma coluna por pedido).
   */
  lista?: {
    readonly itens: readonly number[];
    readonly documento: DocumentoFornecedor;
    /** O TOTAL impresso no documento, para conferir com a soma lida. */
    readonly totalDocumento: number | null;
    referenciaPadrao: string | null;
  };
}

const PALAVRAS: readonly (readonly [PapelColuna, RegExp])[] = [
  ["EAN", /\b(ean|gtin|c[óo]d(igo)?\.?\s*(de\s*)?barras?)\b/i],
  ["NCM", /\bncm\b/i],
  ["OBSERVACAO", /\b(obs|observa[çc][ãa]o|observa[çc][õo]es|nota)\b/i],
  // Código antes de descrição: "CÓDIGO DO PRODUTO" é código.
  ["CODIGO", /\b(c[óo]d(igo)?|sku|ref(\.|er[êe]ncia)?\s*(do\s*)?(produto|item)?|modelo)\b/i],
  ["DESCRICAO", /\b(descri[çc][ãa]o|produto|nome|item)\b/i],
];

/**
 * Números que não são quantidade encomendada. INVOICE e CEST vieram da tabela
 * de códigos de importação (preço em dólar e código fiscal); SOMA e TOTAL, das
 * fórmulas do modelo de pedido.
 */
const NAO_QUANTIDADE =
  /\b(valor|pre[çc]o|price|custo|fob|invoice|usd|us\$|r\$|total|soma|subtotal|peso|kg|cbm|m3|caixa|cx|ctn|unit[áa]rio|margem|cest|ean|gtin|ncm|%)\b/i;
/** Acima disto, a quantidade pede confirmação: um EAN lido como número passaria de 7 trilhões. */
const QUANTIDADE_PLAUSIVEL = 1_000_000;
const CABECALHO_QUANTIDADE = /\b(qtd|qtde|quant(idade)?|pedido|encomendad[oa])\b/i;
/**
 * "30632-1", "31011", "JS31205", "31604-2", "PO-2026-001": um código sem
 * espaço com ao menos três dígitos seguidos. Palavra ("ESTOQUE", "MÍNIMO")
 * nunca vira referência.
 */
const CARA_DE_REFERENCIA = /^(?=[^\s]*\d{3})[A-Z0-9][A-Z0-9\-/.]{2,39}$/i;

/**
 * A referência de um cabeçalho: o próprio código, ou o código antes de uma
 * anotação separada por " - " ("A2026C701A  - ok" → "A2026C701A"). `null`
 * quando o cabeçalho não parece código de pedido.
 */
export function referenciaDoCabecalho(titulo: string): string | null {
  const t = titulo.trim();

  if (CARA_DE_REFERENCIA.test(t)) return t;

  const token = /^(\S+)\s+-\s*.*$/.exec(t)?.[1];

  return token !== undefined && CARA_DE_REFERENCIA.test(token) ? token : null;
}

/** EAN/GTIN escrito como texto ou número, com o apóstrofo do Excel tirado. */
export function limparEan(texto: string): string {
  return texto.trim().replace(/^'+/, "").replace(/\s/g, "");
}

function pareceGtin(c: Celula): boolean {
  return /^\d{8}$|^\d{12,14}$/.test(limparEan(c.texto));
}

export interface Quantidade {
  readonly valor: number | null;
  /** Texto que não é um número simples: a tela exige confirmação. */
  readonly precisaConfirmar: boolean;
}

/**
 * "120" → 120; "1.000" → 1000 (milhar pt-BR); "12,5" → 12,5;
 * "200 + 200" → 400 a CONFIRMAR; "500 + 300 + 7" → 807 a confirmar; outro
 * texto → sem valor, a confirmar. O texto original sempre vai junto.
 */
export function interpretarQuantidade(bruto: string, numerica: boolean): Quantidade {
  const t = bruto.trim();

  if (t === "") return { valor: null, precisaConfirmar: true };

  if (numerica && /^-?\d+(\.\d+)?(E[-+]?\d+)?$/i.test(t)) {
    const n = Number(t);

    return n > 0 ? { valor: n, precisaConfirmar: n > QUANTIDADE_PLAUSIVEL } : { valor: null, precisaConfirmar: true };
  }

  const simples = /^\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, "") : /^\d+(,\d+)?$/.test(t) ? t.replace(",", ".") : null;

  if (simples !== null) {
    const n = Number(simples);

    return n > 0 ? { valor: n, precisaConfirmar: n > QUANTIDADE_PLAUSIVEL } : { valor: null, precisaConfirmar: true };
  }

  if (/^\d+(\s*\+\s*\d+)+$/.test(t)) {
    return { valor: t.split("+").reduce((s, p) => s + Number(p.trim()), 0), precisaConfirmar: true };
  }

  return { valor: null, precisaConfirmar: true };
}

function ehNumero(c: Celula): boolean {
  return c.numerica || /^\d+([.,]\d+)?$/.test(c.texto.trim()) || /^\d+(\s*\+\s*\d+)+$/.test(c.texto.trim());
}

/** A linha de cabeçalho: entre as 15 primeiras, a que mais casa com as palavras conhecidas. */
export function detectarCabecalho(aba: Aba): number {
  let melhor = { linha: 0, pontos: -1 };
  const linhas = [...aba.grade.keys()].sort((a, b) => a - b).slice(0, 15);

  for (const n of linhas) {
    const celulas = [...(aba.grade.get(n)?.values() ?? [])];
    const pontos = celulas.filter((c) => !c.numerica && PALAVRAS.some(([, re]) => re.test(c.texto))).length;

    if (pontos > melhor.pontos) melhor = { linha: n, pontos };
  }

  return melhor.pontos > 0 ? melhor.linha : (linhas[0] ?? 1);
}

export function classificarAba(aba: Aba, linhaCabecalho = detectarCabecalho(aba)): ClassificacaoAba {
  const cabecalho = aba.grade.get(linhaCabecalho) ?? new Map<string, Celula>();
  const colunas = new Set<string>(cabecalho.keys());

  for (const [n, linha] of aba.grade) {
    if (n <= linhaCabecalho) continue;
    for (const c of linha.keys()) colunas.add(c);
  }

  const usados = new Set<PapelColuna>();
  const saida: ColunaClassificada[] = [];

  for (const coluna of [...colunas].sort((a, b) => indiceDaColuna(a) - indiceDaColuna(b))) {
    const titulo = (cabecalho.get(coluna)?.texto ?? "").trim();
    let preenchidas = 0;
    let numericas = 0;
    let decimais = 0;
    let gtins = 0;

    for (const [n, linha] of aba.grade) {
      // Linha com uma célula só é título de seção ("BAU ALUMÍNIO"): não diz o que a coluna é.
      if (n <= linhaCabecalho || linha.size <= 1) continue;
      const c = linha.get(coluna);

      if (c === undefined) continue;
      preenchidas += 1;
      if (pareceGtin(c)) gtins += 1;
      if (ehNumero(c)) {
        numericas += 1;
        // Só número de verdade conta como decimal: "200 + 200" não é preço.
        const n = Number(c.texto.trim().replace(",", "."));

        if (Number.isFinite(n) && !Number.isInteger(n)) decimais += 1;
      }
    }

    let papel: PapelColuna = "IGNORAR";
    let referencia: string | null = null;
    const refDoTitulo = referenciaDoCabecalho(titulo);
    const porPalavra = PALAVRAS.find(([p, re]) => !usados.has(p) && re.test(titulo) && !(p === "CODIGO" && CABECALHO_QUANTIDADE.test(titulo)));
    // Coluna com referência no cabeçalho aceita linhas de título de seção no meio.
    const proporcao = preenchidas === 0 ? 0 : numericas / preenchidas;
    const maioriaNumerica = proporcao >= (refDoTitulo === null ? 0.8 : 0.5);
    const textos = preenchidas - numericas;

    if (porPalavra !== undefined && !(refDoTitulo !== null && maioriaNumerica)) {
      papel = porPalavra[0];
      if (papel !== "OBSERVACAO") usados.add(papel);
    } else if (preenchidas > 0 && gtins / preenchidas >= 0.6) {
      // Números de 8 a 14 dígitos são EAN, nunca quantidade (o MANOPLA do modelo).
      papel = usados.has("EAN") ? "IGNORAR" : "EAN";
      usados.add("EAN");
    } else if (NAO_QUANTIDADE.test(titulo) || (numericas > 0 && decimais / numericas >= 0.3)) {
      // Preço, custo, fiscal ou fórmula de total — e coluna de decimais é preço, não peça.
      papel = "IGNORAR";
    } else if (maioriaNumerica) {
      papel = "QUANTIDADE";
      referencia = refDoTitulo;
    } else if (titulo === "" && textos > 0 && textos / preenchidas >= 0.8) {
      // Texto solto sem cabeçalho ("NÃO VAMOS TRABALHAR", "INATIVO"): guardado como observação.
      papel = "OBSERVACAO";
    }

    saida.push({ coluna, cabecalho: titulo, papel, referencia, preenchidas, numericas });
  }

  return { aba: aba.nome, linhaCabecalho, colunas: saida };
}

export interface LinhaMontada {
  sheet: string;
  row: number;
  column: string;
  code: string | null;
  ean: string | null;
  ncm: string | null;
  description: string | null;
  quantityRaw: string;
  quantity: number | null;
  quantityNeedsConfirmation: boolean;
  reference: string | null;
  notes: string | null;
  /** Invoice: preço unitário e valor da linha, na moeda do documento (null = sem moeda conhecida). */
  unitPrice: number | null;
  amount: number | null;
  currency: string | null;
  unit: string | null;
  document: DocumentoFornecedor | null;
  raw: Record<string, string>;
}

/** A referência da coluna, sem espaço nas pontas; vazia = a informar. */
function referenciaDaColuna(referencia: string | null): string | null {
  const t = (referencia ?? "").trim().slice(0, 80);

  return t === "" ? null : t;
}

/**
 * Uma linha de importação por quantidade preenchida. Linha sem código, EAN e
 * descrição (subtotal, título de seção) não entra. O texto da linha inteira
 * vai em `raw`, para a origem nunca se perder.
 */
export function montarLinhas(aba: Aba, cls: ClassificacaoAba): LinhaMontada[] {
  if (cls.lista !== undefined) return montarLinhasDeLista(aba, cls, cls.lista);

  const por = (p: PapelColuna): string[] => cls.colunas.filter((c) => c.papel === p).map((c) => c.coluna);
  const [codigo] = por("CODIGO");
  const [ean] = por("EAN");
  const [ncm] = por("NCM");
  const [descricao] = por("DESCRICAO");
  const obs = por("OBSERVACAO");
  const quantidades = cls.colunas.filter((c) => c.papel === "QUANTIDADE");
  const saida: LinhaMontada[] = [];
  const texto = (linha: ReadonlyMap<string, Celula>, col: string | undefined): string | null => {
    if (col === undefined) return null;
    const t = linha.get(col)?.texto.trim() ?? "";

    return t === "" ? null : t.slice(0, 500);
  };

  for (const [n, linha] of [...aba.grade].sort((a, b) => a[0] - b[0])) {
    if (n <= cls.linhaCabecalho) continue;

    const code = texto(linha, codigo);
    const eanBruto = texto(linha, ean);
    const eanTexto = eanBruto === null ? null : limparEan(eanBruto);
    const description = texto(linha, descricao);

    if (code === null && eanTexto === null && description === null) continue;

    const notas = obs.map((c) => texto(linha, c)).filter((t): t is string => t !== null);
    const raw: Record<string, string> = {};

    for (const [col, c] of linha) {
      raw[col] = c.formula !== null && c.texto === "" ? `=${c.formula}` : c.texto.slice(0, 200);
    }

    for (const q of quantidades) {
      const c = linha.get(q.coluna);

      if (c === undefined) continue;

      const bruto = c.formula !== null && c.texto.trim() === "" ? `=${c.formula}` : c.texto.trim();

      if (bruto === "" || bruto === "0") continue;

      const qtd = interpretarQuantidade(c.texto, c.numerica);

      saida.push({
        sheet: aba.nome,
        row: n,
        column: colunaDe(`${q.coluna}1`),
        code: code?.slice(0, 120) ?? null,
        ean: eanTexto?.slice(0, 40) ?? null,
        ncm: texto(linha, ncm)?.slice(0, 20) ?? null,
        description,
        quantityRaw: bruto.slice(0, 120),
        quantity: qtd.valor,
        quantityNeedsConfirmation: qtd.precisaConfirmar,
        reference: referenciaDaColuna(q.referencia),
        notes: notas.length === 0 ? null : notas.join(" · ").slice(0, 500),
        unitPrice: null,
        amount: null,
        currency: null,
        unit: null,
        document: null,
        raw,
      });
    }
  }

  return saida;
}

/** Os papéis que o layout de lista achou, como colunas classificadas (o usuário pode trocar). */
function colunasDaLista(aba: Aba, layout: NonNullable<ReturnType<typeof detectarLista>>): ColunaClassificada[] {
  const papelDe = new Map<string, PapelColuna>([
    [layout.quantidade, "QUANTIDADE"],
    [layout.preco, "PRECO"],
  ]);

  if (layout.valor !== null) papelDe.set(layout.valor, "VALOR");
  if (layout.ncm !== null) papelDe.set(layout.ncm, "NCM");
  if (layout.referencia !== null) papelDe.set(layout.referencia, "REFERENCIA");
  if (layout.codigo !== null) papelDe.set(layout.codigo, "CODIGO");
  if (layout.descricao !== null) papelDe.set(layout.descricao, "DESCRICAO");
  if (layout.unidade !== null) papelDe.set(layout.unidade, "UNIDADE");
  for (const c of layout.observacoes) papelDe.set(c, "OBSERVACAO");

  const cabecalho = aba.grade.get(layout.linhaCabecalho);
  const colunas = new Set<string>();

  for (const n of layout.itens) for (const c of aba.grade.get(n)?.keys() ?? []) colunas.add(c);

  for (const c of cabecalho?.keys() ?? []) colunas.add(c);

  const valoresDe = (coluna: string): Celula[] =>
    layout.itens.map((n) => aba.grade.get(n)?.get(coluna)).filter((c): c is Celula => c !== undefined);
  const resultado: ColunaClassificada[] = [];
  // Título impresso numa célula mesclada ("Unit Price" sobre I:J) fica na
  // primeira coluna; o número está na seguinte. O título sem dado embaixo
  // passa para a coluna de dado logo ao lado, se ela não tem título próprio.
  let tituloSolto = { texto: "", indice: -1 };

  for (const coluna of [...colunas].sort((a, b) => indiceDaColuna(a) - indiceDaColuna(b))) {
    const valores = valoresDe(coluna);
    const proprio = textoLimpo(cabecalho?.get(coluna));
    // Só o "$" ao lado do preço, ou nenhum item: não é coluna de dado.
    const semDado = valores.length === 0 || valores.every((c) => ehMoedaSolta(c.texto));

    if (semDado) {
      tituloSolto = { texto: proprio, indice: indiceDaColuna(coluna) };
      continue;
    }

    const herdado = indiceDaColuna(coluna) - tituloSolto.indice === 1 ? tituloSolto.texto : "";

    resultado.push({
      coluna,
      cabecalho: proprio !== "" ? proprio : herdado,
      papel: papelDe.get(coluna) ?? "IGNORAR",
      referencia: null,
      preenchidas: valores.length,
      numericas: valores.filter((c) => numeroDeInvoice(c.texto) !== null).length,
    });
    tituloSolto = { texto: "", indice: -1 };
  }

  return resultado;
}

/**
 * A classificação da aba: invoice/proforma (uma linha por item) quando a aba
 * tem a assinatura quantidade × preço = valor; senão, a matriz do controle de
 * chegada (uma coluna por pedido).
 */
export function classificar(aba: Aba, nomeArquivo = ""): ClassificacaoAba {
  const layout = detectarLista(aba, nomeArquivo);

  if (layout === null) return classificarAba(aba);

  return {
    aba: aba.nome,
    linhaCabecalho: layout.linhaCabecalho,
    colunas: colunasDaLista(aba, layout),
    lista: {
      itens: layout.itens,
      documento: layout.documento,
      totalDocumento: layout.totalDocumento,
      referenciaPadrao: referenciaPadrao(layout.documento, nomeArquivo) },
  };
}

/** Aba que só repete a invoice com peso e caixas: começa desmarcada. */
export function ehListaDeEmbalagem(aba: Aba): boolean {
  if (/^(pl|packing(\s*list)?)$/i.test(aba.nome.trim())) return true;

  for (const [n, linha] of aba.grade) {
    if (n > 25) continue;
    for (const c of linha.values()) if (/packing\s+list/i.test(c.texto)) return true;
  }

  return false;
}

/** Código no começo da descrição quando não há coluna de código ("JDR-37 Com 2 encostos" → "JDR-37"). */
function codigoNoInicio(descricao: string | null): string | null {
  const token = /^(\S+)\s/.exec(descricao ?? "")?.[1];

  return token !== undefined && /[A-Z]/i.test(token) && /\d/.test(token) && token.length <= 30 ? token : null;
}

function montarLinhasDeLista(aba: Aba, cls: ClassificacaoAba, lista: NonNullable<ClassificacaoAba["lista"]>): LinhaMontada[] {
  const por = (p: PapelColuna): string[] => cls.colunas.filter((c) => c.papel === p).map((c) => c.coluna);
  const [codigo] = por("CODIGO");
  const [ean] = por("EAN");
  const [ncm] = por("NCM");
  const [descricao] = por("DESCRICAO");
  const [refCol] = por("REFERENCIA");
  const [preco] = por("PRECO");
  const [valor] = por("VALOR");
  const [unidade] = por("UNIDADE");
  const [quantidade] = por("QUANTIDADE");
  const obs = por("OBSERVACAO");
  const doc = lista.documento;
  const padrao = referenciaDaColuna(lista.referenciaPadrao);
  const resumo = resumoDoDocumento(doc);
  const saida: LinhaMontada[] = [];

  if (quantidade === undefined) return saida;

  const texto = (linha: ReadonlyMap<string, Celula>, col: string | undefined): string | null => {
    if (col === undefined) return null;
    const t = textoLimpo(linha.get(col));

    return t === "" ? null : t.slice(0, 500);
  };
  const numero = (linha: ReadonlyMap<string, Celula>, col: string | undefined): number | null => {
    const t = col === undefined ? undefined : linha.get(col)?.texto;

    return t === undefined ? null : numeroDeInvoice(t);
  };

  for (const n of lista.itens) {
    const linha = aba.grade.get(n);

    if (linha === undefined) continue;

    const description = texto(linha, descricao);
    const code = texto(linha, codigo) ?? (codigo === undefined ? codigoNoInicio(description) : null);
    const eanBruto = texto(linha, ean);
    const eanTexto = eanBruto === null ? null : limparEan(eanBruto);

    if (code === null && eanTexto === null && description === null) continue;

    const c = linha.get(quantidade);
    const bruto = textoLimpo(c);

    if (c === undefined || bruto === "" || bruto === "0") continue;

    const qtdLida = numeroDeInvoice(c.texto);
    const qtd =
      qtdLida !== null && qtdLida > 0
        ? { valor: qtdLida, precisaConfirmar: !Number.isInteger(qtdLida) || qtdLida > QUANTIDADE_PLAUSIVEL }
        : interpretarQuantidade(bruto, c.numerica);
    const unitPrice = numero(linha, preco);
    const amount = numero(linha, valor);
    // Valor que não bate com quantidade × preço: a quantidade pede confirmação.
    const diverge =
      qtd.valor !== null && unitPrice !== null && amount !== null && Math.abs(qtd.valor * unitPrice - amount) > Math.max(0.011, amount * 0.005);
    const unit = texto(linha, unidade)?.slice(0, 20) ?? null;
    const notas = [
      ...obs.map((col) => texto(linha, col)).filter((t): t is string => t !== null),
      ...(unit === null ? [] : [`unidade na invoice: ${unit}`]),
      ...(resumo === null ? [] : [resumo]),
    ];
    const raw: Record<string, string> = {};

    for (const [col, cel] of linha) raw[col] = cel.formula !== null && cel.texto === "" ? `=${cel.formula}` : textoLimpo(cel).slice(0, 200);

    saida.push({
      sheet: aba.nome,
      row: n,
      column: quantidade,
      code: code?.slice(0, 120) ?? null,
      ean: eanTexto?.slice(0, 40) ?? null,
      ncm: texto(linha, ncm)?.slice(0, 20) ?? null,
      description,
      quantityRaw: bruto.slice(0, 120),
      quantity: qtd.valor,
      quantityNeedsConfirmation: qtd.precisaConfirmar || diverge,
      reference: referenciaDaColuna(texto(linha, refCol)) ?? padrao,
      notes: notas.length === 0 ? null : notas.join(" · ").slice(0, 500),
      unitPrice,
      amount,
      currency: doc.moeda,
      unit,
      document: doc,
      raw,
    });
  }

  return saida;
}

/** SHA-256 em hexadecimal do conteúdo do arquivo: a identidade do lote. */
export async function sha256Hex(dados: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", dados);

  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
