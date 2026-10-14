export { SHOPEE_HOSTS, ShopeeApiError, createShopeeClient, isShopLevelError, sign, signBaseString } from "./client.js";
export type {
  ShopeeClient,
  ShopeeClientConfig,
  ShopeeEnvironment,
  ShopeeErrorClass,
  ShopeeRequest,
} from "./client.js";

export {
  REFRESH_TOKEN_TTL_MS,
  buildAuthorizationUrl,
  getAccessToken,
  isDefinitiveRefreshRefusal,
  refreshAccessToken,
  shopeeTokenSchema,
} from "./auth.js";
export type { ShopeeToken } from "./auth.js";

export { getShopInfo, shopInfoSchema, shopeeEpochToIso } from "./shop.js";
export type { ShopInfo } from "./shop.js";

export {
  ORDER_DETAIL_BATCH,
  ORDER_LIST_MAX_WINDOW_S,
  ORDER_LIST_PAGE_SIZE,
  getOrderDetail,
  getOrderListPage,
  shopeeOrderSchema,
} from "./orders.js";
export type { OrderListPage, ShopeeOrder } from "./orders.js";

export { getEscrowDetail, isEscrowUnavailable, orderIncomeSchema } from "./payment.js";
export type { ShopeeEscrowDetail, ShopeeOrderIncome } from "./payment.js";

export {
  ITEM_BASE_INFO_BATCH,
  ITEM_LIST_PAGE_SIZE,
  getItemBaseInfo,
  getItemListPage,
  getModelList,
  precoEEstoque,
  shopeeItemSchema,
  shopeeModelSchema,
} from "./products.js";
export type { ItemBaseInfo, ItemListPage, ModelList, ShopeeItem, ShopeeItemStatus, ShopeeModel } from "./products.js";

export { RETURN_LIST_MAX_WINDOW_S, RETURN_LIST_PAGE_SIZE, getReturnListPage, shopeeReturnSchema } from "./returns.js";
export type { ReturnListPage, ShopeeReturn } from "./returns.js";
