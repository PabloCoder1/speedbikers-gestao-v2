import {
  classifyListingRef,
  isMercadoLivreStore,
  storeLabel,
  storeSlug,
} from "./listing-ref.js";
import type { ListingRef } from "./listing-ref.js";
import {
  cell,
  normalizeUnit,
  parseCategory,
  parseDecimal,
  parseFlag,
  parseOriginCode,
  skuKey,
} from "./normalize.js";

/**
 * Mapeamento das linhas exportadas pelo UpSeller para registros normalizados.
 *
 * DECISÃO: mapear por NOME de coluna, nunca por posição.
 *
 * A exportação tem 37 colunas no catálogo. Se o UpSeller inserir uma coluna no
 * meio — e ERPs fazem isso em atualização de versão — o mapeamento posicional
 * desloca tudo em silêncio: NCM vira unidade, custo vira peso, e a importação
 * grava dado plausível e errado. Por nome, uma coluna nova é ignorada e uma
 * coluna renomeada falha alto.
 */

export type RowResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

/**
 * Índice de cabeçalho tolerante a caixa, acento e espaço.
 *
 * Medido na exportação: os cabeçalhos vêm com acento (`Título`, `Armazém`) e um
 * deles carrega parêntese de largura total — `Em Trânsito(Transferência）`.
 * Comparar texto cru quebraria nesse.
 */
export type HeaderIndex = ReadonlyMap<string, number>;

function normalizeHeader(value: unknown): string {
  return (cell(value) ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function buildHeaderIndex(header: readonly unknown[]): HeaderIndex {
  const index = new Map<string, number>();

  header.forEach((name, position) => {
    const key = normalizeHeader(name);

    // Primeira ocorrência vence: cabeçalho duplicado não deve sobrescrever.
    if (key.length > 0 && !index.has(key)) {
      index.set(key, position);
    }
  });

  return index;
}

function at(row: readonly unknown[], index: HeaderIndex, header: string): unknown {
  const position = index.get(normalizeHeader(header));

  return position === undefined ? null : row[position];
}

/** Confere que o arquivo é o esperado antes de processar 3.400 linhas. */
export function missingColumns(index: HeaderIndex, required: readonly string[]): string[] {
  return required.filter((name) => !index.has(normalizeHeader(name)));
}

// ---------------------------------------------------------------------------
// Catálogo — export_warehouse_products
// ---------------------------------------------------------------------------

export interface UpsellerProduct {
  sku: string;
  skuKey: string;
  title: string | null;
  erpProductCode: string | null;
  erpSpu: string | null;
  brand: string | null;
  categoryRaw: string | null;
  isDiscontinued: boolean;
  isActive: boolean;
  originCode: number | null;
  unit: string | null;
  barcode: string | null;
  ncm: string | null;
  cest: string | null;
  retailPrice: number | null;
  purchaseCost: number | null;
  weightG: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  imageUrl: string | null;
}

export const PRODUCT_COLUMNS = ["SKU", "Título", "Código do Produto"] as const;

export function mapProductRow(
  row: readonly unknown[],
  index: HeaderIndex,
): RowResult<UpsellerProduct> {
  const sku = cell(at(row, index, "SKU"));

  if (sku === null) {
    return { ok: false, reason: "linha sem SKU" };
  }

  const category = parseCategory(at(row, index, "Categorias"));

  return {
    ok: true,
    value: {
      sku,
      skuKey: skuKey(sku),
      title: cell(at(row, index, "Título")),
      erpProductCode: cell(at(row, index, "Código do Produto")),
      erpSpu: cell(at(row, index, "SPU")),
      brand: category.brand,
      categoryRaw: category.categoryRaw,
      isDiscontinued: category.isDiscontinued,
      isActive: parseFlag(at(row, index, "O produto está ativo"), true),
      originCode: parseOriginCode(at(row, index, "Origem")),
      unit: normalizeUnit(at(row, index, "Unidade")),
      barcode: cell(at(row, index, "Código de Barras")),
      ncm: cell(at(row, index, "NCM")),
      cest: cell(at(row, index, "CEST")),
      retailPrice: parseDecimal(at(row, index, "Preço de varejo")),
      purchaseCost: parseDecimal(at(row, index, "Custo de Compra")),
      weightG: parseDecimal(at(row, index, "Peso (g)")),
      lengthCm: parseDecimal(at(row, index, "Comprimento (cm)")),
      widthCm: parseDecimal(at(row, index, "Largura (cm)")),
      heightCm: parseDecimal(at(row, index, "Altura (cm)")),
      imageUrl: cell(at(row, index, "Imagem")),
    },
  };
}

// ---------------------------------------------------------------------------
// Kits — export_kit
//
// Uma linha por COMPONENTE, não por kit. Medido: 272 linhas para 138 kits.
// ---------------------------------------------------------------------------

export interface UpsellerKitComponent {
  kitSku: string;
  kitSkuKey: string;
  kitTitle: string | null;
  componentSku: string;
  componentSkuKey: string;
  quantity: number;
}

export const KIT_COLUMNS = ["KIT SKU", "SKU de Produto", "Qtd. SKU de Produto"] as const;

export function mapKitRow(
  row: readonly unknown[],
  index: HeaderIndex,
): RowResult<UpsellerKitComponent> {
  const kit = cell(at(row, index, "KIT SKU"));
  const component = cell(at(row, index, "SKU de Produto"));

  if (kit === null) {
    return { ok: false, reason: "linha sem KIT SKU" };
  }

  if (component === null) {
    return { ok: false, reason: `kit ${kit} sem SKU de componente` };
  }

  if (skuKey(kit) === skuKey(component)) {
    return { ok: false, reason: `kit ${kit} contém a si mesmo` };
  }

  const quantity = parseDecimal(at(row, index, "Qtd. SKU de Produto"));

  if (quantity === null || quantity <= 0) {
    return { ok: false, reason: `kit ${kit}: quantidade inválida para ${component}` };
  }

  return {
    ok: true,
    value: {
      kitSku: kit,
      kitSkuKey: skuKey(kit),
      kitTitle: cell(at(row, index, "Título")),
      componentSku: component,
      componentSkuKey: skuKey(component),
      quantity,
    },
  };
}

// ---------------------------------------------------------------------------
// Vínculos — SKU_Map_Relationship
// ---------------------------------------------------------------------------

export interface UpsellerLink {
  skuKey: string;
  channelSku: string | null;
  storeLabel: string;
  storeSlug: string;
  ref: Extract<ListingRef, { kind: "ITEM" } | { kind: "USER_PRODUCT" }>;
}

export const LINK_COLUMNS = ["SKU", "ID do Anúncio", "Nome da Loja"] as const;

/** `skipped` distingue "descartado por decisão" de "erro" — D-037. */
export type LinkResult =
  | { ok: true; value: UpsellerLink }
  | { ok: false; reason: string; skipped?: boolean };

export function mapLinkRow(row: readonly unknown[], index: HeaderIndex): LinkResult {
  const store = at(row, index, "Nome da Loja");

  // D-037: apenas Mercado Livre. Não é erro — é a decisão sendo aplicada.
  if (!isMercadoLivreStore(store)) {
    return { ok: false, reason: "canal fora do Mercado Livre", skipped: true };
  }

  const sku = cell(at(row, index, "SKU"));

  if (sku === null) {
    return { ok: false, reason: "linha sem SKU" };
  }

  const label = storeLabel(store);
  const slug = storeSlug(store);

  if (label === null || slug === null) {
    return { ok: false, reason: "nome de loja irreconhecível" };
  }

  const ref = classifyListingRef(at(row, index, "ID do Anúncio"), at(row, index, "ID da Variante"));

  if (ref.kind === "INVALID") {
    return { ok: false, reason: ref.reason };
  }

  return {
    ok: true,
    value: {
      skuKey: skuKey(sku),
      channelSku: cell(at(row, index, "Mapeado SKU do Anúncio")),
      storeLabel: label,
      storeSlug: slug,
      ref,
    },
  };
}

// ---------------------------------------------------------------------------
// Estoque — Lista_de_Estoque
// ---------------------------------------------------------------------------

export interface UpsellerStock {
  skuKey: string;
  warehouse: string;
  onHand: number;
  available: number;
  reserved: number;
  inTransit: number;
  averageCost: number | null;
}

export const STOCK_COLUMNS = ["SKU", "Armazém", "Estoque Atual"] as const;

export function mapStockRow(
  row: readonly unknown[],
  index: HeaderIndex,
): RowResult<UpsellerStock> {
  const sku = cell(at(row, index, "SKU"));

  if (sku === null) {
    return { ok: false, reason: "linha sem SKU" };
  }

  const onHand = parseDecimal(at(row, index, "Estoque Atual"));

  if (onHand === null) {
    return { ok: false, reason: `SKU ${sku} sem Estoque Atual` };
  }

  // As duas colunas de trânsito vêm zeradas em todas as 3.372 linhas: o recurso
  // existe no ERP e não é usado. Somadas mesmo assim, para o dia em que passar
  // a ser — o `em trânsito` da V3 vem dos pedidos de compra, não daqui.
  const transitPurchase = parseDecimal(at(row, index, "Em Trânsito(Compra)")) ?? 0;
  const transitTransfer = parseDecimal(at(row, index, "Em Trânsito(Transferência)")) ?? 0;

  return {
    ok: true,
    value: {
      skuKey: skuKey(sku),
      warehouse: cell(at(row, index, "Armazém")) ?? "PADRAO",
      onHand,
      available: parseDecimal(at(row, index, "Disponível")) ?? onHand,
      // "Ocupado" no ERP é o reservado da V3.
      reserved: parseDecimal(at(row, index, "Ocupado")) ?? 0,
      inTransit: transitPurchase + transitTransfer,
      averageCost: parseDecimal(at(row, index, "Custo Médio")),
    },
  };
}
