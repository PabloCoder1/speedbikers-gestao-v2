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

export type PapelColuna = "CODIGO" | "EAN" | "NCM" | "DESCRICAO" | "OBSERVACAO" | "QUANTIDADE" | "IGNORAR";

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
        raw,
      });
    }
  }

  return saida;
}

/** SHA-256 em hexadecimal do conteúdo do arquivo: a identidade do lote. */
export async function sha256Hex(dados: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", dados);

  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
