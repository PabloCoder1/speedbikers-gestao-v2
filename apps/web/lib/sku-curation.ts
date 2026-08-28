/**
 * Curadoria do catálogo: a fronteira de ENTRADA da tela `/produtos` (D-133).
 *
 * Duas colunas de `skus` só podem ser preenchidas por gente, e cada uma tem um
 * motivo medido:
 *
 * - `stock_is_virtual` (D-127): o saldo do ERP é um sentinela, não contagem.
 *   Não existe sinal derivável — a hipótese "base menos vendas acumuladas"
 *   foi testada e reprovada (correlação 0,291).
 * - `supplier_brand` (D-129): `skus.brand` guarda a CATEGORIA do UpSeller
 *   (66% em 'MANETE') e o importador a sobrescreve a cada planilha.
 *
 * Este módulo normaliza e recusa ANTES de tocar o banco, para o operador ler
 * a própria língua em vez de uma violação de CHECK crua. As regras espelham
 * exatamente as constraints da migration `20260828210048` e a normalização da
 * RPC — se divergirem, o banco vence e o erro fica feio, nunca errado.
 */

/** Espelha o CHECK `skus_supplier_brand_shape`. */
const MARCA_MAX = 60;

export type VirtualDecision = "VIRTUAL" | "FISICO" | "INDEFINIDO";

const DECISOES: readonly VirtualDecision[] = ["VIRTUAL", "FISICO", "INDEFINIDO"];

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/**
 * Normaliza a marca do fornecedor exatamente como a RPC faz
 * (`upper(btrim(...))`), mais o colapso de espaço interno que o SQL não faz.
 *
 * Devolve `null` para entrada vazia, e isso é um VALOR, não um erro: marca
 * vazia significa LIMPAR, que é a única forma de desfazer um preenchimento
 * errado. Quem chama precisa distinguir "limpar" de "preencher" antes de
 * confirmar com o operador, porque limpar apaga trabalho humano.
 *
 * Medido antes de escrever: nenhuma das 1.280 marcas já existentes muda com
 * esta normalização (maior tem 12 caracteres, nenhuma fora de caixa alta,
 * nenhuma com espaço nas bordas) — logo ela não cria marca gêmea.
 */
export function normalizeSupplierBrand(raw: string): ParseResult<string | null> {
  const colapsado = raw.replace(/\s+/g, " ").trim().toUpperCase();

  if (colapsado === "") {
    return { ok: true, value: null };
  }

  if (colapsado.length > MARCA_MAX) {
    return { ok: false, message: `A marca precisa ter no máximo ${String(MARCA_MAX)} caracteres.` };
  }

  return { ok: true, value: colapsado };
}

/** Recusa contra lista fechada — o mesmo conjunto que a RPC aceita. */
export function parseVirtualDecision(raw: string): ParseResult<VirtualDecision> {
  const achado = DECISOES.find((d) => d === raw);

  if (achado === undefined) {
    return { ok: false, message: "Decisão inválida." };
  }

  return { ok: true, value: achado };
}

/**
 * O teto de 500 é o mesmo da RPC. Existe aqui também para o operador receber
 * uma frase em vez de uma exceção do Postgres — e porque é raio de explosão,
 * não desempenho: com a seleção presa a uma página de 100, 500 já são cinco
 * páginas inteiras.
 */
export const MAX_SELECAO = 500;

export function parseSelecao(ids: readonly string[]): ParseResult<string[]> {
  const unicos = [...new Set(ids.filter((id) => id !== ""))];

  if (unicos.length === 0) {
    return { ok: false, message: "Selecione ao menos um SKU." };
  }

  if (unicos.length > MAX_SELECAO) {
    return {
      ok: false,
      message: `Selecione no máximo ${String(MAX_SELECAO)} SKUs por vez (${String(unicos.length)} selecionados).`,
    };
  }

  return { ok: true, value: unicos };
}

export interface CurationOutcome {
  readonly applied: number;
  readonly unchanged: number;
  readonly notFound: number;
  /** Só os que MUDARAM — é o que o botão Desfazer deve mandar de volta. */
  readonly changedIds: string[];
}

/**
 * Apura o retorno POR LINHA da RPC.
 *
 * Não é agregação movida para o Node (o que `docs/ARCHITECTURE.md` secao 15
 * proíbe): são no máximo 500 linhas que a própria chamada acabou de devolver,
 * e o total já veio contado. Sem esta apuração, o filtro de no-op fica
 * invisível e "412 marcados" pode significar 8.
 */
export function summarizeCuration(rows: readonly { sku_id: string; status: string }[]): CurationOutcome {
  const changedIds = rows.filter((r) => r.status === "APLICADO").map((r) => r.sku_id);

  return {
    applied: changedIds.length,
    unchanged: rows.filter((r) => r.status === "JA_DECIDIDO").length,
    notFound: rows.filter((r) => r.status === "NAO_ENCONTRADO").length,
    changedIds,
  };
}

/** Frase única para a faixa de resultado — sem esconder o que não mudou. */
export function describeOutcome(outcome: CurationOutcome): string {
  const partes = [`${String(outcome.applied)} aplicado(s)`];

  if (outcome.unchanged > 0) {
    partes.push(`${String(outcome.unchanged)} já estava(m) assim`);
  }

  if (outcome.notFound > 0) {
    partes.push(`${String(outcome.notFound)} sumiu(ram) da lista — recarregue`);
  }

  return partes.join(" · ");
}
