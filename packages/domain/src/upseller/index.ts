export {
  cell,
  normalizeUnit,
  parseCategory,
  parseDecimal,
  parseFlag,
  parseOriginCode,
  skuKey,
} from "./normalize.js";
export type { CategoryParse } from "./normalize.js";

export {
  classifyListingRef,
  isMercadoLivreStore,
  storeLabel,
  storeSlug,
} from "./listing-ref.js";
export type { ListingRef } from "./listing-ref.js";

export {
  buildHeaderIndex,
  KIT_COLUMNS,
  LINK_COLUMNS,
  mapKitRow,
  mapLinkRow,
  mapProductRow,
  mapStockRow,
  missingColumns,
  PRODUCT_COLUMNS,
  STOCK_COLUMNS,
} from "./rows.js";
export type {
  HeaderIndex,
  LinkResult,
  RowResult,
  UpsellerKitComponent,
  UpsellerLink,
  UpsellerProduct,
  UpsellerStock,
} from "./rows.js";
export * from "./apply.js";
