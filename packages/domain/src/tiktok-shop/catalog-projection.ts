import { parseDecimalOpcional } from "./order-projection.js";

/**
 * Projeção pura do catálogo e estoque do TikTok Shop (D-813, `M04`,
 * `docs/TIKTOK_SHOP.md` §8):
 *
 * - classifica estados oficiais do produto (`ACTIVATE`, `SELLER_DEACTIVATED`,
 *   `PLATFORM_DEACTIVATED`, `FREEZE`, `DELETED`, `DRAFT`, `PENDING`) de forma
 *   total e sem vazamento de `Object.prototype`;
 * - normaliza variações (`skus[]`) preservando ausência de preço/estoque como
 *   `null` (nunca `0`) e priorizando `POST /product/202309/inventory/search`
 *   quando disponível;
 * - gera `sellerSkuKey` normalizado (`trim().toUpperCase()`) para matching
 *   determinístico contra o catálogo interno de SKUs.
 */

export type TikTokProductLifecycle = "ATIVO" | "PAUSADO" | "EXCLUIDO" | "RASCUNHO" | "DESCONHECIDO";

export interface TikTokCatalogSkuPriceInput {
  readonly currency?: string | null;
  readonly tax_exclusive_price?: string | null;
  readonly sale_price?: string | null;
}

export interface TikTokCatalogWarehouseInput {
  readonly warehouse_id: string;
  readonly quantity: number;
}

export interface TikTokCatalogSkuInput {
  readonly id: string;
  readonly seller_sku?: string | null;
  readonly price?: TikTokCatalogSkuPriceInput | null;
  readonly inventory?: readonly TikTokCatalogWarehouseInput[] | null;
}

export interface TikTokCatalogProductInput {
  readonly id: string;
  readonly title?: string | null;
  readonly status: string;
  readonly create_time?: number | null;
  readonly update_time?: number | null;
  readonly skus?: readonly TikTokCatalogSkuInput[] | null;
}

export interface TikTokSkuInventoryOverride {
  readonly totalAvailableQuantity?: number | null;
  readonly totalCommittedQuantity?: number | null;
}

export interface ProjectedTikTokListingUnit {
  readonly productId: string;
  readonly skuId: string | null;
  readonly sellerSku: string | null;
  readonly sellerSkuKey: string | null;
  readonly title: string | null;
  readonly rawStatus: string;
  readonly lifecycle: TikTokProductLifecycle;
  readonly currency: string | null;
  readonly originalPriceBrl: number | null;
  readonly salePriceBrl: number | null;
  readonly availableStock: number | null;
  readonly committedStock: number | null;
  readonly createdAtIso: string | null;
  readonly updatedAtIso: string | null;
}

const PRODUCT_LIFECYCLE: Readonly<Record<string, TikTokProductLifecycle>> = {
  ACTIVATE: "ATIVO",
  SELLER_DEACTIVATED: "PAUSADO",
  PLATFORM_DEACTIVATED: "PAUSADO",
  FREEZE: "PAUSADO",
  FAILED: "PAUSADO",
  DELETED: "EXCLUIDO",
  DRAFT: "RASCUNHO",
  PENDING: "RASCUNHO",
};

const MAX_UNIX_EPOCH_SECONDS = 8_640_000_000_000;

export function classifyTikTokProductStatus(status: string): TikTokProductLifecycle {
  const key = status.trim().toUpperCase();

  return Object.hasOwn(PRODUCT_LIFECYCLE, key) ? (PRODUCT_LIFECYCLE[key] ?? "DESCONHECIDO") : "DESCONHECIDO";
}

function textoOuNulo(valor: string | null | undefined): string | null {
  if (typeof valor !== "string") return null;
  const trimmed = valor.trim();

  return trimmed === "" ? null : trimmed;
}

function epochParaIso(epoch: number | null | undefined): string | null {
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch <= 0 || epoch > MAX_UNIX_EPOCH_SECONDS) {
    return null;
  }

  return new Date(epoch * 1000).toISOString();
}

function inteiroNaoNegativoOuNulo(valor: number | null | undefined): number | null {
  if (typeof valor !== "number" || !Number.isSafeInteger(valor) || valor < 0) return null;

  return valor;
}

function somarDepositos(warehouses: readonly TikTokCatalogWarehouseInput[] | null | undefined): number | null {
  if (warehouses === undefined || warehouses === null || warehouses.length === 0) return null;

  let total = 0;
  let validos = 0;

  for (const w of warehouses) {
    if (!Number.isSafeInteger(w.quantity) || w.quantity < 0) continue;
    total += w.quantity;
    validos += 1;
  }

  if (validos === 0 || !Number.isSafeInteger(total)) return null;

  return total;
}

/**
 * Projeta um produto TikTok Shop e suas variações em unidades normalizadas de anúncio.
 * Quando `inventoryBySkuId` contém entrada para o `sku.id`, prioriza `totalAvailableQuantity`
 * e `totalCommittedQuantity` vindos de `POST /product/202309/inventory/search`.
 */
export function projectTikTokProductCatalog(
  product: TikTokCatalogProductInput,
  inventoryBySkuId?: Readonly<Record<string, TikTokSkuInventoryOverride>>,
): ProjectedTikTokListingUnit[] {
  const productId = product.id.trim();

  if (productId === "") {
    throw new RangeError("projectTikTokProductCatalog: product.id obrigatório");
  }

  const title = textoOuNulo(product.title);
  const rawStatus = product.status.trim();
  const lifecycle = classifyTikTokProductStatus(rawStatus);
  const createdAtIso = epochParaIso(product.create_time);
  const updatedAtIso = epochParaIso(product.update_time);
  const skus = product.skus ?? [];

  if (skus.length === 0) {
    return [
      {
        productId,
        skuId: null,
        sellerSku: null,
        sellerSkuKey: null,
        title,
        rawStatus,
        lifecycle,
        currency: null,
        originalPriceBrl: null,
        salePriceBrl: null,
        availableStock: null,
        committedStock: null,
        createdAtIso,
        updatedAtIso,
      },
    ];
  }

  const bySkuId = new Map<string, ProjectedTikTokListingUnit>();

  for (const sku of skus) {
    const skuId = sku.id.trim();

    if (skuId === "") continue;

    const sellerSku = textoOuNulo(sku.seller_sku);
    const sellerSkuKey = sellerSku === null ? null : sellerSku.toUpperCase();
    const override =
      inventoryBySkuId !== undefined && Object.hasOwn(inventoryBySkuId, skuId) ? inventoryBySkuId[skuId] : undefined;
    const availableFromOverride = inteiroNaoNegativoOuNulo(override?.totalAvailableQuantity);
    const availableStock = availableFromOverride ?? somarDepositos(sku.inventory);
    const committedStock = inteiroNaoNegativoOuNulo(override?.totalCommittedQuantity);
    const originalPriceBrl = parseDecimalOpcional(sku.price?.tax_exclusive_price);
    const salePriceBrl = parseDecimalOpcional(sku.price?.sale_price);

    bySkuId.set(skuId, {
      productId,
      skuId,
      sellerSku,
      sellerSkuKey,
      title,
      rawStatus,
      lifecycle,
      currency: textoOuNulo(sku.price?.currency),
      originalPriceBrl: originalPriceBrl !== null && originalPriceBrl >= 0 ? originalPriceBrl : null,
      salePriceBrl: salePriceBrl !== null && salePriceBrl >= 0 ? salePriceBrl : null,
      availableStock,
      committedStock,
      createdAtIso,
      updatedAtIso,
    });
  }

  return [...bySkuId.values()];
}
