/**
 * Normalização dos campos exportados pelo UpSeller.
 *
 * Funções puras, sem I/O. Cada regra aqui veio de um fato medido na exportação
 * real de 2026-08-20 — a análise completa está em `docs/UPSELLER.md`.
 *
 * Por que isto vive em `@sb/domain` e não no importador: a mesma normalização
 * será aplicada em toda importação futura, e uma regra que mora junto do
 * parser acaba duplicada no dia em que houver um segundo parser.
 */

/** Célula vazia do UpSeller: pode vir nula, vazia ou com um traço. */
export function cell(value: unknown): string | null {
  // Tipos tratados explicitamente em vez de `String(value)`: uma célula de
  // planilha pode conter Date, e um objeto inesperado viraria "[object Object]"
  // silenciosamente — texto que parece dado válido e não é.
  let text: string;

  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number") {
    text = Number.isFinite(value) ? value.toString() : "";
  } else if (typeof value === "boolean") {
    text = value ? "Y" : "N";
  } else if (value instanceof Date) {
    text = value.toISOString();
  } else {
    return null;
  }

  const trimmed = text.trim();

  return trimmed.length === 0 || trimmed === "-" ? null : trimmed;
}

/**
 * Identidade normalizada do SKU.
 *
 * O banco já gera `sku_key` por coluna gerada; esta função existe para o
 * importador conseguir agrupar e deduplicar ANTES de tocar o banco.
 */
export function skuKey(sku: string): string {
  return sku.trim().toUpperCase();
}

/**
 * Unidade de medida.
 *
 * Medido: 11 valores distintos com duplicata semântica — `UN` (2.492),
 * `PAR` (441), `KIT` (275), `PC` (60), `UNID` (33), `PECAS` (16), `PA` (3).
 * `UN`/`UNID` e `PC`/`PECAS` são a mesma coisa escrita diferente; `PA` é
 * abreviação de `PAR`.
 *
 * Sem normalizar, um filtro por unidade divide o mesmo grupo em três.
 *
 * `JOGO`/`JOGOS` e `CX` aparecem na exportação e NÃO são normalizados de
 * propósito: um jogo e uma caixa são unidades de venda genuinamente distintas
 * de `UN`. Fundir por parecerem próximas perderia informação real.
 */
const UNIT_ALIASES: Readonly<Record<string, string>> = {
  UN: "UN",
  UNI: "UN",
  UNID: "UN",
  UNIDADE: "UN",
  PC: "UN",
  PECA: "UN",
  PECAS: "UN",
  PÇ: "UN",
  PAR: "PAR",
  PA: "PAR",
  PARES: "PAR",
  KIT: "KIT",
  CJ: "KIT",
  CONJUNTO: "KIT",
};

export function normalizeUnit(raw: unknown): string | null {
  const value = cell(raw);

  if (value === null) {
    return null;
  }

  const upper = value.toUpperCase();

  return UNIT_ALIASES[upper] ?? upper;
}

/**
 * Marca e situação, derivadas da coluna `Categorias`.
 *
 * A coluna `Marca` do ERP está 90% vazia; a marca real vive em `Categorias`
 * (D-039). E `Categorias` carrega três coisas ao mesmo tempo:
 *
 *   - marca            `NAVETEC`, `OFFRACER`, `PLASMOTO`
 *   - linha de produto `MANETE→XRE/BROS/TORNADO` (hierarquia por seta)
 *   - situação         `ESTOQUE INATIVO`
 *
 * `ESTOQUE INATIVO` NÃO é lixo: marca produto em encerramento, cujo estoque
 * está sendo zerado para deixar de ser trabalhado. Vira `isDiscontinued`.
 *
 * Categorias puramente numéricas (`999`) são ruído e não viram marca.
 */
export interface CategoryParse {
  brand: string | null;
  isDiscontinued: boolean;
  categoryRaw: string | null;
}

const DISCONTINUED_MARKER = "ESTOQUE INATIVO";

export function parseCategory(raw: unknown): CategoryParse {
  const value = cell(raw);

  if (value === null) {
    return { brand: null, isDiscontinued: false, categoryRaw: null };
  }

  const upper = value.toUpperCase();

  if (upper === DISCONTINUED_MARKER) {
    return { brand: null, isDiscontinued: true, categoryRaw: value };
  }

  // Hierarquia por seta: a marca/família é a parte antes do separador.
  const head = upper.split(/→|->/)[0]?.trim() ?? "";

  // Categoria só de dígitos é ruído de cadastro, não marca.
  const brand = head.length > 0 && !/^\d+$/.test(head) ? head : null;

  return { brand, isDiscontinued: false, categoryRaw: value };
}

/**
 * Código de origem da NF-e.
 *
 * Medido: 98% preenchido, com valores `0` (3.055), `1` (267) e `2` (29). É a
 * tabela fiscal padrão, não classificação nossa — por isso o código é
 * preservado e `is_imported` é derivado dele no banco.
 */
export function parseOriginCode(raw: unknown): number | null {
  const value = cell(raw);

  if (value === null) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 8 ? parsed : null;
}

/**
 * Número decimal vindo da planilha.
 *
 * Aceita tanto `174.90` quanto `174,90`: a exportação varia conforme a
 * configuração regional de quem exporta.
 */
export function parseDecimal(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }

  const value = cell(raw);

  if (value === null) {
    return null;
  }

  // A vírgula decide quem é quem. Com vírgula presente, ela é o separador
  // decimal e os pontos são milhar (`1.174,90`). Sem vírgula, o ponto É o
  // separador decimal (`174.90`).
  //
  // Remover ponto sempre transformaria 174.90 em 17490 — multiplicando por cem
  // todo preço e custo da importação, em silêncio.
  const normalized = value.includes(",")
    ? value.replace(/\./g, "").replace(",", ".")
    : value;

  const parsed = Number.parseFloat(normalized);

  return Number.isFinite(parsed) ? parsed : null;
}

/** `Y` / `N` do UpSeller. */
export function parseFlag(raw: unknown, fallback: boolean): boolean {
  const value = cell(raw);

  if (value === null) {
    return fallback;
  }

  return value.toUpperCase() === "Y";
}
