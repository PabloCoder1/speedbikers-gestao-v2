/**
 * A leitura de `get_supplier_skus` (D-723) com o contrato conferido — o mesmo
 * desenho de `replenishment-overview.ts`: campo fora do formato recusa a
 * resposta inteira, em vez de virar "—" calado na tela.
 */

export interface ProdutoFornecido {
  readonly id: string;
  readonly skuId: string;
  readonly sku: string;
  readonly title: string | null;
  readonly supplierCode: string | null;
  readonly unitCost: number | null;
  readonly currency: string;
  /** O custo do CADASTRO do SKU, para comparar com o do fornecedor. */
  readonly cadastroCost: number | null;
  readonly minimumOrderQuantity: number | null;
  readonly packMultiple: number | null;
  readonly leadTimeDays: number | null;
  readonly isPreferred: boolean;
  readonly notes: string | null;
  readonly isDiscontinued: boolean;
  readonly unidadesCompradas: number | null;
  readonly pedidos: number;
  readonly ultimaCompra: string | null;
}

export interface ListaProdutosFornecidos {
  readonly total: number;
  readonly linhas: readonly ProdutoFornecido[];
}

type Obj = Record<string, unknown>;

const ehObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ehNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOuNulo = (v: unknown): v is number | null => v === null || ehNum(v);
const textoOuNulo = (v: unknown): v is string | null => v === null || typeof v === "string";

function lerLinha(v: unknown): ProdutoFornecido | null {
  if (!ehObj(v)) return null;
  if (typeof v.id !== "string" || typeof v.sku_id !== "string" || typeof v.sku !== "string" || typeof v.currency !== "string") {
    return null;
  }
  if (!textoOuNulo(v.title) || !textoOuNulo(v.supplier_code) || !textoOuNulo(v.notes) || !textoOuNulo(v.ultima_compra)) return null;
  if (!numOuNulo(v.unit_cost) || !numOuNulo(v.cadastro_cost) || !numOuNulo(v.minimum_order_quantity)) return null;
  if (!numOuNulo(v.pack_multiple) || !numOuNulo(v.lead_time_days) || !numOuNulo(v.unidades_compradas) || !ehNum(v.pedidos)) {
    return null;
  }
  if (typeof v.is_preferred !== "boolean" || typeof v.is_discontinued !== "boolean") return null;

  return {
    id: v.id,
    skuId: v.sku_id,
    sku: v.sku,
    title: v.title,
    supplierCode: v.supplier_code,
    unitCost: v.unit_cost,
    currency: v.currency,
    cadastroCost: v.cadastro_cost,
    minimumOrderQuantity: v.minimum_order_quantity,
    packMultiple: v.pack_multiple,
    leadTimeDays: v.lead_time_days,
    isPreferred: v.is_preferred,
    notes: v.notes,
    isDiscontinued: v.is_discontinued,
    unidadesCompradas: v.unidades_compradas,
    pedidos: v.pedidos,
    ultimaCompra: v.ultima_compra,
  };
}

export function lerProdutosFornecidos(dado: unknown): ListaProdutosFornecidos | null {
  if (!ehObj(dado) || !ehNum(dado.total) || !Array.isArray(dado.linhas)) return null;

  const linhas: ProdutoFornecido[] = [];

  for (const l of dado.linhas) {
    const linha = lerLinha(l);

    if (linha === null) return null;
    linhas.push(linha);
  }

  return { total: dado.total, linhas };
}
