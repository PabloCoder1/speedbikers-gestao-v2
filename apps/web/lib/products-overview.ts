/**
 * A leitura de `get_products_overview` (D-373) — contrato conferido campo a
 * campo, sem React e sem banco.
 *
 * Mesmo desenho de `lib/purchase-orders-overview.ts`: a RPC devolve `jsonb`, e
 * uma resposta fora do contrato é recusada INTEIRA. Um campo renomeado no SQL
 * não pode chegar como `undefined` e sair "—", que se lê como "não observado".
 *
 * Nada aqui soma: contagens e totais vêm do SQL.
 */

export interface LinhaProduto {
  readonly sku_id: string;
  readonly sku: string;
  readonly title: string | null;
  /** A CATEGORIA do UpSeller (D-129). */
  readonly brand: string | null;
  readonly supplier_brand: string | null;
  readonly supplier_brand_source: string | null;
  readonly stock_is_virtual: boolean;
  readonly stock_is_virtual_set_at: string | null;
  readonly snapshot_available: number | null;
  /** `null` = sem retrato do ERP (terceiro estado, D-133). */
  readonly has_sentinel_signature: boolean | null;
  readonly units_sold_90d: number;
  readonly decision_diverges_from_signature: boolean;
  readonly listing_count: number;
  readonly created_at: string;
  readonly updated_at: string;
  /** `null` só na leitura antiga (`get_sku_curation`), que não traz estes campos. */
  readonly kind: "PRODUTO" | "KIT" | null;
  readonly situacao: "ATIVO" | "ENCERRANDO" | "INATIVO" | null;
  readonly retail_price: number | null;
  readonly purchase_cost: number | null;
}

export interface Contagem {
  readonly valor: string | null;
  readonly n: number;
}

export interface FacetasProdutos {
  readonly estado: { todos: number; pendente: number; virtual: number; fisico: number };
  readonly sinal: { todos: number; sentinela: number; sem_sinal: number; sem_retrato: number; divergente: number };
  readonly marcas: readonly Contagem[];
  readonly categorias: readonly Contagem[];
  readonly tipo: { todos: number; produto: number; kit: number };
  readonly situacao: { todos: number; ativo: number; encerrando: number; inativo: number };
  readonly anuncios: { todos: number; com: number; sem: number };
  readonly vendas: { todos: number; com: number; sem: number };
}

export interface ResumoCatalogo {
  readonly total: number;
  readonly nunca_classificados: number;
  readonly virtuais: number;
  readonly sem_marca: number;
  readonly a_revisar: number;
  /** Só SKUs ativos: inativo sem anúncio não é pendência. */
  readonly sem_anuncio: number;
  readonly sem_venda_90d: number;
  readonly encerrando: number;
  readonly retrato_em: string | null;
}

export interface VisaoProdutos {
  readonly total: number;
  readonly linhas: readonly LinhaProduto[];
  readonly facetas: FacetasProdutos;
  readonly resumo: ResumoCatalogo;
}

type Obj = Record<string, unknown>;

const ehObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ehNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOuNulo = (v: unknown): v is number | null => v === null || ehNum(v);
const textoOuNulo = (v: unknown): v is string | null => v === null || typeof v === "string";

/** Lê um objeto de contagens com exatamente estas chaves numéricas. */
function lerContagens<K extends string>(v: unknown, chaves: readonly K[]): Record<K, number> | null {
  if (!ehObj(v)) return null;

  const saida = {} as Record<K, number>;

  for (const chave of chaves) {
    const valor = v[chave];

    if (!ehNum(valor)) return null;
    saida[chave] = valor;
  }

  return saida;
}

function lerLista(v: unknown): Contagem[] | null {
  if (!Array.isArray(v)) return null;

  const saida: Contagem[] = [];

  for (const item of v) {
    if (!ehObj(item) || !textoOuNulo(item.valor) || !ehNum(item.n)) return null;
    saida.push({ valor: item.valor, n: item.n });
  }

  return saida;
}

const KINDS = new Set(["PRODUTO", "KIT"]);
const SITUACOES = new Set(["ATIVO", "ENCERRANDO", "INATIVO"]);

function lerLinha(v: unknown): LinhaProduto | null {
  if (!ehObj(v)) return null;
  if (typeof v.sku_id !== "string" || typeof v.sku !== "string") return null;
  if (typeof v.created_at !== "string" || typeof v.updated_at !== "string") return null;
  if (typeof v.stock_is_virtual !== "boolean" || typeof v.decision_diverges_from_signature !== "boolean") return null;
  if (v.has_sentinel_signature !== null && typeof v.has_sentinel_signature !== "boolean") return null;
  if (!ehNum(v.units_sold_90d) || !ehNum(v.listing_count)) return null;
  if (!numOuNulo(v.snapshot_available) || !numOuNulo(v.retail_price) || !numOuNulo(v.purchase_cost)) return null;

  for (const campo of ["title", "brand", "supplier_brand", "supplier_brand_source", "stock_is_virtual_set_at"]) {
    if (!textoOuNulo(v[campo])) return null;
  }

  if (typeof v.kind !== "string" || !KINDS.has(v.kind)) return null;
  if (typeof v.situacao !== "string" || !SITUACOES.has(v.situacao)) return null;

  return {
    sku_id: v.sku_id,
    sku: v.sku,
    title: v.title as string | null,
    brand: v.brand as string | null,
    supplier_brand: v.supplier_brand as string | null,
    supplier_brand_source: v.supplier_brand_source as string | null,
    stock_is_virtual: v.stock_is_virtual,
    stock_is_virtual_set_at: v.stock_is_virtual_set_at as string | null,
    snapshot_available: v.snapshot_available,
    has_sentinel_signature: v.has_sentinel_signature,
    units_sold_90d: v.units_sold_90d,
    decision_diverges_from_signature: v.decision_diverges_from_signature,
    listing_count: v.listing_count,
    created_at: v.created_at,
    updated_at: v.updated_at,
    kind: v.kind as "PRODUTO" | "KIT",
    situacao: v.situacao as "ATIVO" | "ENCERRANDO" | "INATIVO",
    retail_price: v.retail_price,
    purchase_cost: v.purchase_cost,
  };
}

/** `null` = resposta fora do contrato. A tela recusa em vez de mostrar pedaço. */
export function lerVisaoProdutos(dado: unknown): VisaoProdutos | null {
  if (!ehObj(dado) || !ehNum(dado.total) || !Array.isArray(dado.linhas)) return null;
  if (!ehObj(dado.facetas) || !ehObj(dado.resumo)) return null;

  const f = dado.facetas;
  const estado = lerContagens(f.estado, ["todos", "pendente", "virtual", "fisico"] as const);
  const sinal = lerContagens(f.sinal, ["todos", "sentinela", "sem_sinal", "sem_retrato", "divergente"] as const);
  const tipo = lerContagens(f.tipo, ["todos", "produto", "kit"] as const);
  const situacao = lerContagens(f.situacao, ["todos", "ativo", "encerrando", "inativo"] as const);
  const anuncios = lerContagens(f.anuncios, ["todos", "com", "sem"] as const);
  const vendas = lerContagens(f.vendas, ["todos", "com", "sem"] as const);
  const marcas = lerLista(f.marcas);
  const categorias = lerLista(f.categorias);

  if (estado === null || sinal === null || tipo === null || situacao === null) return null;
  if (anuncios === null || vendas === null || marcas === null || categorias === null) return null;

  const resumoNumeros = lerContagens(dado.resumo, [
    "total",
    "nunca_classificados",
    "virtuais",
    "sem_marca",
    "a_revisar",
    "sem_anuncio",
    "sem_venda_90d",
    "encerrando",
  ] as const);

  if (resumoNumeros === null || !textoOuNulo(dado.resumo.retrato_em)) return null;

  const linhas: LinhaProduto[] = [];

  for (const item of dado.linhas) {
    const linha = lerLinha(item);

    if (linha === null) return null;
    linhas.push(linha);
  }

  return {
    total: dado.total,
    linhas,
    facetas: { estado, sinal, marcas, categorias, tipo, situacao, anuncios, vendas },
    resumo: { ...resumoNumeros, retrato_em: dado.resumo.retrato_em },
  };
}

/** Linha de `get_sku_curation` — a leitura antiga, enquanto a migration de D-373 não chegou ao banco. */
export interface LinhaCuradoriaLegado {
  sku_id: string;
  sku: string;
  title: string | null;
  brand: string | null;
  supplier_brand: string | null;
  supplier_brand_source: string | null;
  stock_is_virtual: boolean;
  stock_is_virtual_set_at: string | null;
  snapshot_available: number | null;
  has_sentinel_signature: boolean | null;
  units_sold_90d: number;
  decision_diverges_from_signature: boolean;
  total_count: number;
  listing_count: number;
  created_at: string;
  updated_at: string;
}

/** A leitura antiga na forma nova: o que ela não sabe fica nulo, nunca inventado. */
export function linhaDoLegado(row: LinhaCuradoriaLegado): LinhaProduto {
  return {
    sku_id: row.sku_id,
    sku: row.sku,
    title: row.title,
    brand: row.brand,
    supplier_brand: row.supplier_brand,
    supplier_brand_source: row.supplier_brand_source,
    stock_is_virtual: row.stock_is_virtual,
    stock_is_virtual_set_at: row.stock_is_virtual_set_at,
    snapshot_available: row.snapshot_available,
    has_sentinel_signature: row.has_sentinel_signature,
    units_sold_90d: row.units_sold_90d,
    decision_diverges_from_signature: row.decision_diverges_from_signature,
    listing_count: row.listing_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
    kind: null,
    situacao: null,
    retail_price: null,
    purchase_cost: null,
  };
}

/**
 * As opções de um menu de categoria/marca: as `limite` maiores, e a ativa
 * sempre incluída — escolher uma categoria pequena não pode fazê-la sumir do
 * próprio menu. A ausência ("sem categoria") vai por último.
 */
export function opcoesDeLista(
  lista: readonly Contagem[],
  ativo: string | null,
  semValor: string,
  limite: number,
): { principais: Contagem[]; demais: Contagem[] } {
  const comValor = lista.filter((c) => c.valor !== null);
  const sem = lista.find((c) => c.valor === null);
  const principais = comValor.slice(0, limite);
  const demais = comValor.slice(limite);

  if (ativo !== null && ativo !== semValor && !principais.some((c) => c.valor === ativo)) {
    const achado = demais.find((c) => c.valor === ativo) ?? { valor: ativo, n: 0 };

    principais.push(achado);

    return { principais, demais: demais.filter((c) => c.valor !== ativo).concat(sem === undefined ? [] : [sem]) };
  }

  return { principais, demais: sem === undefined ? demais : [...demais, sem] };
}
