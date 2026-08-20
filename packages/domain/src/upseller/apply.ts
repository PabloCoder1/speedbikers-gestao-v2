/**
 * Leitura de volta do que a conferência gravou.
 *
 * O parser escreveu registros tipados em `erp_import_rows.payload`, coluna
 * `jsonb`. Na volta eles são `unknown` de verdade: podem ter sido gravados por
 * uma versão anterior do parser, semanas antes da aplicação. Confiar no
 * formato aqui seria confiar num tipo que o compilador não pode verificar.
 *
 * Por isso cada campo é lido com verificação, e uma linha fora do formato vira
 * `UNRESOLVED` com motivo legível — nunca `undefined` viajando até o `INSERT`
 * para virar `null` numa coluna `not null` e derrubar o lote inteiro.
 *
 * Sem dependência externa, como todo o resto de `@sb/domain`.
 */

export type ReadResult<T> = { ok: true; value: T } | { ok: false; reason: string };

type Record_ = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): Record_ | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record_)
    : null;
}

function str(source: Record_, key: string): string | null {
  const value = source[key];

  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function bool(source: Record_, key: string): boolean {
  return source[key] === true;
}

/** Número finito ou `null`. `NaN` e `Infinity` nunca chegam ao banco. */
function numberOrNull(source: Record_, key: string): number | null {
  const value = source[key];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Produtos
// ---------------------------------------------------------------------------

export interface SkuUpsert {
  sku: string;
  title: string | null;
  erp_product_code: string | null;
  erp_spu: string | null;
  brand: string | null;
  category_raw: string | null;
  is_discontinued: boolean;
  is_active: boolean;
  origin_code: number | null;
  unit: string | null;
  barcode: string | null;
  ncm: string | null;
  cest: string | null;
  retail_price: number | null;
  purchase_cost: number | null;
  weight_g: number | null;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  image_url: string | null;
}

export function readSkuUpsert(payload: unknown): ReadResult<SkuUpsert> {
  const source = asRecord(payload);

  if (source === null) return { ok: false, reason: "conteúdo da linha ilegível" };

  const sku = str(source, "sku");

  if (sku === null) return { ok: false, reason: "linha sem SKU" };

  // `origin_code` tem check 0..8 no banco. Um valor fora disso derrubaria o
  // INSERT do lote inteiro; descartar o campo preserva o resto da linha.
  const origin = numberOrNull(source, "originCode");

  return {
    ok: true,
    value: {
      sku,
      title: str(source, "title"),
      erp_product_code: str(source, "erpProductCode"),
      erp_spu: str(source, "erpSpu"),
      brand: str(source, "brand"),
      category_raw: str(source, "categoryRaw"),
      is_discontinued: bool(source, "isDiscontinued"),
      // Ausente significa ativo: o ERP só marca o contrário.
      is_active: source.isActive !== false,
      origin_code: origin !== null && Number.isInteger(origin) && origin >= 0 && origin <= 8 ? origin : null,
      unit: str(source, "unit"),
      barcode: str(source, "barcode"),
      ncm: str(source, "ncm"),
      cest: str(source, "cest"),
      retail_price: numberOrNull(source, "retailPrice"),
      purchase_cost: numberOrNull(source, "purchaseCost"),
      weight_g: numberOrNull(source, "weightG"),
      length_cm: numberOrNull(source, "lengthCm"),
      width_cm: numberOrNull(source, "widthCm"),
      height_cm: numberOrNull(source, "heightCm"),
      image_url: str(source, "imageUrl"),
    },
  };
}

// ---------------------------------------------------------------------------
// Kits
// ---------------------------------------------------------------------------

export interface KitComponentRef {
  kitSkuKey: string;
  componentSkuKey: string;
  quantity: number;
}

export function readKitComponent(payload: unknown): ReadResult<KitComponentRef> {
  const source = asRecord(payload);

  if (source === null) return { ok: false, reason: "conteúdo da linha ilegível" };

  const kitSkuKey = str(source, "kitSkuKey");
  const componentSkuKey = str(source, "componentSkuKey");
  const quantity = numberOrNull(source, "quantity");

  if (kitSkuKey === null || componentSkuKey === null) {
    return { ok: false, reason: "linha sem kit ou sem componente" };
  }

  // `quantity > 0` é check do banco, e o auto-componente é proibido por
  // constraint. Barrar aqui transforma "o lote inteiro falhou" em "esta linha
  // ficou pendente".
  if (quantity === null || quantity <= 0) {
    return { ok: false, reason: "quantidade ausente ou não positiva" };
  }

  if (kitSkuKey === componentSkuKey) {
    return { ok: false, reason: "kit contém a si mesmo" };
  }

  return { ok: true, value: { kitSkuKey, componentSkuKey, quantity } };
}

// ---------------------------------------------------------------------------
// Vínculos
// ---------------------------------------------------------------------------

export interface ListingLinkRef {
  skuKey: string;
  storeSlug: string;
  storeLabel: string;
  refKind: "ITEM" | "USER_PRODUCT";
  itemId: string | null;
  variationId: string | null;
  userProductId: string | null;
  channelSku: string | null;
}

const ITEM_ID = /^MLB[0-9]+$/;
const USER_PRODUCT_ID = /^MLBU[0-9]+$/;
const VARIATION_ID = /^[0-9]+$/;

export function readListingLink(payload: unknown): ReadResult<ListingLinkRef> {
  const source = asRecord(payload);

  if (source === null) return { ok: false, reason: "conteúdo da linha ilegível" };

  const skuKey = str(source, "skuKey");
  const slug = str(source, "storeSlug");
  const label = str(source, "storeLabel");
  const ref = asRecord(source.ref);

  if (skuKey === null) return { ok: false, reason: "linha sem SKU" };
  if (slug === null || label === null) return { ok: false, reason: "linha sem loja" };
  if (ref === null) return { ok: false, reason: "linha sem identificador de anúncio" };

  const channelSku = str(source, "channelSku");
  const kind = ref.kind;

  if (kind === "USER_PRODUCT") {
    const userProductId = str(ref, "userProductId");

    // Os mesmos formatos que o banco exige por check. Validar aqui é o que
    // impede uma linha torta abortar a inserção das outras 999 do bloco.
    if (userProductId === null || !USER_PRODUCT_ID.test(userProductId)) {
      return { ok: false, reason: "identificador de produto do catálogo inválido" };
    }

    return {
      ok: true,
      value: {
        skuKey,
        storeSlug: slug,
        storeLabel: label,
        refKind: "USER_PRODUCT",
        itemId: null,
        variationId: null,
        userProductId,
        channelSku,
      },
    };
  }

  if (kind !== "ITEM") {
    return { ok: false, reason: "tipo de anúncio não reconhecido" };
  }

  const itemId = str(ref, "itemId");

  if (itemId === null || !ITEM_ID.test(itemId) || USER_PRODUCT_ID.test(itemId)) {
    return { ok: false, reason: "identificador de anúncio inválido" };
  }

  const variationId = str(ref, "variationId");

  if (variationId !== null && !VARIATION_ID.test(variationId)) {
    return { ok: false, reason: "identificador de variação inválido" };
  }

  return {
    ok: true,
    value: {
      skuKey,
      storeSlug: slug,
      storeLabel: label,
      refKind: "ITEM",
      itemId,
      variationId,
      userProductId: null,
      channelSku,
    },
  };
}

// ---------------------------------------------------------------------------
// Estoque
// ---------------------------------------------------------------------------

export interface StockSnapshotRef {
  skuKey: string;
  warehouse: string;
  onHand: number;
  available: number;
  reserved: number;
  inTransit: number;
  averageCost: number | null;
}

export function readStockSnapshot(payload: unknown): ReadResult<StockSnapshotRef> {
  const source = asRecord(payload);

  if (source === null) return { ok: false, reason: "conteúdo da linha ilegível" };

  const skuKey = str(source, "skuKey");
  const warehouse = str(source, "warehouse");

  if (skuKey === null) return { ok: false, reason: "linha sem SKU" };
  if (warehouse === null) return { ok: false, reason: "linha sem armazém" };

  const onHand = numberOrNull(source, "onHand");
  const available = numberOrNull(source, "available");

  // Saldo é o dado; sem ele a linha não tem o que dizer. Reservado e em
  // trânsito ausentes viram zero, que é o significado de "nada reservado".
  if (onHand === null || available === null) {
    return { ok: false, reason: "linha sem saldo" };
  }

  return {
    ok: true,
    value: {
      skuKey,
      warehouse,
      onHand,
      available,
      reserved: numberOrNull(source, "reserved") ?? 0,
      inTransit: numberOrNull(source, "inTransit") ?? 0,
      averageCost: numberOrNull(source, "averageCost"),
    },
  };
}
