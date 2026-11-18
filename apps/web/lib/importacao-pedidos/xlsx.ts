/**
 * Leitura mínima de .xlsx para a importação de pedidos anteriores (D-764).
 *
 * Um .xlsx é um zip. Os modelos de pedido têm CENTENAS de imagens embutidas
 * (`xl/media/*`), e ler o arquivo com uma biblioteca de planilha completa
 * descompacta tudo. Aqui só se abrem quatro tipos de parte: `workbook.xml`
 * (nomes das abas), as relações do workbook, `sharedStrings.xml` e as abas
 * escolhidas. O zip descompacta por entrada e sob demanda, então as imagens
 * nunca saem do arquivo.
 *
 * O texto da célula é preservado como estava: código com zero à esquerda e
 * letras é texto na planilha e continua texto; "200 + 200" continua
 * "200 + 200". Fórmula sem valor em cache vira texto vazio com a fórmula ao
 * lado — nunca um número calculado aqui.
 */

export const TAMANHO_MAXIMO_BYTES = 60 * 1024 * 1024;
export const LINHAS_MAXIMAS_POR_ABA = 20_000;
export const COLUNAS_MAXIMAS = 80;

export interface Celula {
  readonly texto: string;
  /** Fórmula da célula, quando havia. */
  readonly formula: string | null;
  /** Valor numérico gravado como número (não como texto). */
  readonly numerica: boolean;
}

/** linha (1-based) → coluna ("A") → célula. Só as não vazias. */
export type Grade = ReadonlyMap<number, ReadonlyMap<string, Celula>>;

export interface Aba {
  readonly nome: string;
  readonly grade: Grade;
  /** A aba passou do limite e foi cortada: a tela avisa. */
  readonly cortada: boolean;
}

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodificarXml(texto: string): string {
  return texto.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (inteiro, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));

    return ENTIDADES[e] ?? inteiro;
  });
}

/** O texto de um <si> ou <is>: todos os <t>, inclusive dos trechos com formatação (<r>). */
function textoRico(xml: string): string {
  // <rPh> é a leitura fonética (japonês): não é texto da célula.
  const semFonetica = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let saida = "";

  for (const m of semFonetica.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) {
    saida += decodificarXml(m[1] ?? "");
  }

  return saida;
}

export function lerSharedStrings(xml: string): string[] {
  const saida: string[] = [];

  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) {
    saida.push(textoRico(m[1] ?? ""));
  }

  return saida;
}

export function colunaDe(ref: string): string {
  return /^[A-Z]+/.exec(ref)?.[0] ?? "";
}

export function indiceDaColuna(coluna: string): number {
  let n = 0;

  for (const ch of coluna) n = n * 26 + (ch.charCodeAt(0) - 64);

  return n;
}

export function lerAba(xml: string, compartilhadas: readonly string[]): { grade: Grade; cortada: boolean } {
  const grade = new Map<number, Map<string, Celula>>();
  let cortada = false;

  for (const linha of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const numero = Number(/\br="(\d+)"/.exec(linha[1] ?? "")?.[1]);

    if (!Number.isFinite(numero)) continue;
    if (numero > LINHAS_MAXIMAS_POR_ABA) {
      cortada = true;
      break;
    }

    const celulas = new Map<string, Celula>();

    for (const c of (linha[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] ?? "";
      const corpo = c[2] ?? "";
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];

      if (ref === undefined || indiceDaColuna(ref) > COLUNAS_MAXIMAS) continue;

      const tipo = /\bt="([a-zA-Z]+)"/.exec(attrs)?.[1] ?? "n";
      const v = /<v>([\s\S]*?)<\/v>/.exec(corpo)?.[1];
      const f = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(corpo)?.[1] ?? (/<f\b[^>]*\/>/.test(corpo) ? "" : null);
      let texto: string;

      if (tipo === "s") texto = compartilhadas[Number(v)] ?? "";
      else if (tipo === "inlineStr") texto = textoRico(/<is>([\s\S]*?)<\/is>/.exec(corpo)?.[1] ?? "");
      else if (tipo === "b") texto = v === "1" ? "VERDADEIRO" : v === "0" ? "FALSO" : "";
      else if (tipo === "e") texto = "";
      else texto = decodificarXml(v ?? "");

      const formula = f === null ? null : decodificarXml(f);

      if (texto.trim() === "" && formula === null) continue;

      celulas.set(ref, { texto, formula, numerica: tipo === "n" && v !== undefined });
    }

    if (celulas.size > 0) grade.set(numero, celulas);
  }

  return { grade, cortada };
}

export interface AbaDoWorkbook {
  readonly nome: string;
  readonly caminho: string;
}

/** As abas na ordem do workbook, com o caminho da parte de cada uma. */
export function lerWorkbook(workbookXml: string, relsXml: string): AbaDoWorkbook[] {
  const alvos = new Map<string, string>();

  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = m[1] ?? "";
    const id = /\bId="([^"]+)"/.exec(attrs)?.[1];
    const alvo = /\bTarget="([^"]+)"/.exec(attrs)?.[1];

    if (id !== undefined && alvo !== undefined) alvos.set(id, alvo);
  }

  const abas: AbaDoWorkbook[] = [];

  for (const m of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = m[1] ?? "";
    const nome = /\bname="([^"]*)"/.exec(attrs)?.[1];
    const rid = /\br:id="([^"]+)"/.exec(attrs)?.[1] ?? /\bid="([^"]+)"/.exec(attrs)?.[1];
    const alvo = rid === undefined ? undefined : alvos.get(rid);

    if (nome === undefined || alvo === undefined) continue;

    const caminho = alvo.startsWith("/") ? alvo.slice(1) : `xl/${alvo.replace(/^\.\//, "")}`;

    abas.push({ nome: decodificarXml(nome), caminho });
  }

  return abas;
}

/** O zip mínimo de que a leitura precisa — o JSZip no navegador, um objeto em teste. */
export interface ZipLeitura {
  texto(caminho: string): Promise<string | null>;
}

export async function lerPlanilha(zip: ZipLeitura, abasEscolhidas?: readonly string[]): Promise<{ abas: Aba[]; todas: string[] }> {
  const workbook = await zip.texto("xl/workbook.xml");
  const rels = await zip.texto("xl/_rels/workbook.xml.rels");

  if (workbook === null || rels === null) throw new Error("O arquivo não parece um .xlsx válido (workbook ausente).");

  const doWorkbook = lerWorkbook(workbook, rels);
  const compartilhadasXml = await zip.texto("xl/sharedStrings.xml");
  const compartilhadas = compartilhadasXml === null ? [] : lerSharedStrings(compartilhadasXml);
  const abas: Aba[] = [];

  for (const aba of doWorkbook) {
    if (abasEscolhidas !== undefined && !abasEscolhidas.includes(aba.nome)) continue;

    const xml = await zip.texto(aba.caminho);

    if (xml === null) continue;

    const { grade, cortada } = lerAba(xml, compartilhadas);

    abas.push({ nome: aba.nome, grade, cortada });
  }

  return { abas, todas: doWorkbook.map((a) => a.nome) };
}
