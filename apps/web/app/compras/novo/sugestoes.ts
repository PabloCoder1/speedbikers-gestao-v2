/**
 * A sugestão da reposição dentro do pedido (D-371) — leitura de
 * `get_purchase_order_suggestions` e as peças puras que a tela usa, sem React
 * e sem banco.
 *
 * A RPC devolve `jsonb` (`Json` no gerador). Cada campo é conferido e uma
 * resposta fora do contrato é recusada INTEIRA — o desenho de
 * `lib/replenishment-overview.ts`. Nenhuma conta aqui: sugestão, estado e
 * cobertura são os de `get_purchase_suggestions`, a mesma de /reposicao.
 */

export interface SugestaoItem {
  readonly skuId: string;
  readonly sku: string;
  readonly title: string | null;
  readonly supplierBrand: string | null;
  /** Custo CADASTRADO — sugestão editável no pedido, nunca volta ao cadastro (D-149). */
  readonly purchaseCost: number | null;
  readonly isImported: boolean | null;
  /** Nulo = a reposição recusa sugerir (sem configuração, estoque virtual, histórico ou amostra). */
  readonly state: string | null;
  /** Nulo = recusa; 0 = a janela já está coberta. */
  readonly suggestedQuantity: number | null;
  readonly coverageDays: number | null;
  readonly units30d: number;
  /** Local + Full + trânsito − reservado. Nulo em estoque virtual (D-127). */
  readonly aproveitavel: number | null;
}

export interface SugestoesPedido {
  readonly total: number;
  readonly linhas: readonly SugestaoItem[];
}

type Obj = Record<string, unknown>;

const ehObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ehNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOuNulo = (v: unknown): v is number | null => v === null || ehNum(v);
const textoOuNulo = (v: unknown): v is string | null => v === null || typeof v === "string";

function lerLinha(v: unknown): SugestaoItem | null {
  if (!ehObj(v)) return null;
  if (typeof v.sku_id !== "string" || typeof v.sku !== "string") return null;
  if (!textoOuNulo(v.title) || !textoOuNulo(v.supplier_brand) || !textoOuNulo(v.state)) return null;
  if (!numOuNulo(v.purchase_cost) || !numOuNulo(v.suggested_quantity) || !numOuNulo(v.coverage_days)) return null;
  if (!numOuNulo(v.aproveitavel) || !ehNum(v.units_30d)) return null;
  if (v.is_imported !== null && typeof v.is_imported !== "boolean") return null;

  return {
    skuId: v.sku_id,
    sku: v.sku,
    title: v.title,
    supplierBrand: v.supplier_brand,
    purchaseCost: v.purchase_cost,
    isImported: v.is_imported,
    state: v.state,
    suggestedQuantity: v.suggested_quantity,
    coverageDays: v.coverage_days,
    units30d: v.units_30d,
    aproveitavel: v.aproveitavel,
  };
}

/** `null` = resposta fora do contrato. */
export function lerSugestoes(dado: unknown): SugestoesPedido | null {
  if (!ehObj(dado) || !ehNum(dado.total) || !Array.isArray(dado.linhas)) return null;

  const linhas: SugestaoItem[] = [];

  for (const item of dado.linhas) {
    const linha = lerLinha(item);

    if (linha === null) return null;
    linhas.push(linha);
  }

  return { total: dado.total, linhas };
}

/** O vocabulário de estado da reposição (D-148), curto para caber na célula. */
export const ESTADO_SUGESTAO: Record<string, { rotulo: string; tom: "perigo" | "atencao" | "ok" | "info" }> = {
  RUPTURA: { rotulo: "Ruptura", tom: "perigo" },
  COMPRA_URGENTE: { rotulo: "Urgente", tom: "perigo" },
  COMPRAR_EM_BREVE: { rotulo: "Em breve", tom: "atencao" },
  COBERTURA_BAIXA: { rotulo: "Cobertura baixa", tom: "atencao" },
  ADEQUADA: { rotulo: "Adequada", tom: "ok" },
  EXCESSO: { rotulo: "Excesso", tom: "info" },
};

const normalizar = (texto: string): string =>
  texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * A marca que corresponde ao fornecedor escolhido, quando dá para afirmar.
 *
 * Fornecedor e marca são eixos diferentes no modelo (D-174: não existe vínculo
 * fornecedor→SKU), mas na operação o fornecedor costuma SER a marca. A tela só
 * pré-seleciona quando o nome bate: igual (sem acento e caixa) ou a marca
 * aparece como palavra inteira no nome ("GIVI" em "Givi Brasil Ltda"). Mais de
 * uma marca candidata não é certeza: fica a mais longa, que é a mais
 * específica. Nada bate → nada pré-selecionado, a pessoa escolhe.
 */
export function marcaDoFornecedor(nomeFornecedor: string | null, marcas: readonly string[]): string | null {
  if (nomeFornecedor === null) return null;

  const nome = ` ${normalizar(nomeFornecedor)} `;

  if (nome.trim() === "") return null;

  const candidatas = marcas.filter((marca) => {
    const m = normalizar(marca);

    return m !== "" && (nome.trim() === m || nome.includes(` ${m} `));
  });

  if (candidatas.length === 0) return null;

  return [...candidatas].sort((a, b) => normalizar(b).length - normalizar(a).length)[0] ?? null;
}
