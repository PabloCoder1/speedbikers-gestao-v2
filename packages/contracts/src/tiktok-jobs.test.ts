import { describe, expect, it } from "vitest";

import { toTaskName } from "./job.js";
import {
  TIKTOK_ITEMS_DELAY_S,
  TIKTOK_JOB_TYPES,
  TIKTOK_JOB_TYPE_LIST,
  TIKTOK_PUSH_WINDOW_S,
  isTikTokJobType,
  parseTikTokJobPayload,
  tiktokFinancialsSyncPayloadSchema,
  tiktokItemsSyncPayloadSchema,
  tiktokOrderFetchDedupeKey,
  tiktokOrderFetchPayloadSchema,
  tiktokOrdersSyncPayloadSchema,
  tiktokPushDedupeKey,
  tiktokPushWindowBucket,
  tiktokReturnsSyncPayloadSchema,
  tiktokScheduleDedupeKey,
} from "./tiktok-jobs.js";

const SHOP_UUID = "bbbbbbbb-0000-4000-8000-0000000000b1";

describe("contratos de jobs TikTok Shop (D-812)", () => {
  it("expõe nomes canônicos, constantes de janela/atraso e guarda isTikTokJobType", () => {
    expect(TIKTOK_PUSH_WINDOW_S).toBe(300);
    expect(TIKTOK_ITEMS_DELAY_S).toBe(300);
    expect(TIKTOK_JOB_TYPES).toEqual({
      ordersSync: "tiktok.orders.sync",
      itemsSync: "tiktok.items.sync",
      orderFetch: "tiktok.order.fetch",
      returnsSync: "tiktok.returns.sync",
      financialsSync: "tiktok.financials.sync",
    });
    expect(TIKTOK_JOB_TYPE_LIST).toHaveLength(5);
    expect(isTikTokJobType("tiktok.orders.sync")).toBe(true);
    expect(isTikTokJobType("tiktok.financials.sync")).toBe(true);
    expect(isTikTokJobType("shopee.orders.sync")).toBe(false);
    expect(isTikTokJobType("toString")).toBe(false);
  });

  it("valida payloads estritos e recusa campos inválidos ou em branco", () => {
    expect(tiktokOrdersSyncPayloadSchema.parse({ tiktokShopId: SHOP_UUID, notificationId: "  n-1 " })).toEqual({
      tiktokShopId: SHOP_UUID,
      notificationId: "n-1",
    });
    expect(tiktokItemsSyncPayloadSchema.parse({ tiktokShopId: SHOP_UUID })).toEqual({ tiktokShopId: SHOP_UUID });
    expect(
      tiktokOrderFetchPayloadSchema.parse({ tiktokShopId: SHOP_UUID, orderId: " 576461413038785752 " }),
    ).toEqual({
      tiktokShopId: SHOP_UUID,
      orderId: "576461413038785752",
    });
    expect(tiktokReturnsSyncPayloadSchema.parse({ tiktokShopId: SHOP_UUID })).toEqual({ tiktokShopId: SHOP_UUID });
    expect(tiktokFinancialsSyncPayloadSchema.parse({ tiktokShopId: SHOP_UUID, orderId: "ord-1" })).toEqual({
      tiktokShopId: SHOP_UUID,
      orderId: "ord-1",
    });

    expect(() => tiktokOrdersSyncPayloadSchema.parse({ tiktokShopId: "not-a-uuid" })).toThrow();
    expect(() => tiktokOrdersSyncPayloadSchema.parse({ tiktokShopId: SHOP_UUID, notificationId: "   " })).toThrow();
    expect(() => tiktokOrderFetchPayloadSchema.parse({ tiktokShopId: SHOP_UUID, orderId: "   " })).toThrow();
    expect(() => tiktokFinancialsSyncPayloadSchema.parse({ tiktokShopId: SHOP_UUID, orderId: "" })).toThrow();
  });

  it("parseTikTokJobPayload despacha pelo jobType e falha fechado em tipo desconhecido ou chave de protótipo", () => {
    const ok = parseTikTokJobPayload("tiktok.orders.sync", { tiktokShopId: SHOP_UUID });
    expect(ok.success).toBe(true);

    const badType = parseTikTokJobPayload("toString", { tiktokShopId: SHOP_UUID });
    expect(badType.success).toBe(false);

    const badPayload = parseTikTokJobPayload("tiktok.order.fetch", { tiktokShopId: SHOP_UUID });
    expect(badPayload.success).toBe(false);
  });

  it("calcula janela de coalescência de 5 min e chaves determinísticas compatíveis com toTaskName", () => {
    const now = new Date("2026-11-24T12:02:10.000Z");
    const bucket = tiktokPushWindowBucket(now);

    expect(bucket).toEqual({
      nowSeconds: Math.floor(now.getTime() / 1000),
      bucketEndSeconds: Math.floor(new Date("2026-11-24T12:05:00.000Z").getTime() / 1000),
      delaySeconds: 170,
    });

    const pushOrders = tiktokPushDedupeKey("tiktok.orders.sync", SHOP_UUID, bucket.bucketEndSeconds);
    const pushReturns = tiktokPushDedupeKey("tiktok.returns.sync", SHOP_UUID, bucket.bucketEndSeconds);
    const schedOrders = tiktokScheduleDedupeKey("tiktok.orders.sync", SHOP_UUID, "2026-11-24T14");
    const schedItems = tiktokScheduleDedupeKey("tiktok.items.sync", SHOP_UUID, "2026-11-24T14");
    const schedFin = tiktokScheduleDedupeKey("tiktok.financials.sync", SHOP_UUID, "2026-11-24T14");
    const fetchOrder = tiktokOrderFetchDedupeKey(SHOP_UUID, "576461413038785752", bucket.bucketEndSeconds);

    expect(pushOrders).toBe(`tiktok-orders-push:${SHOP_UUID}:${String(bucket.bucketEndSeconds)}`);
    expect(pushReturns).toBe(`tiktok-returns-push:${SHOP_UUID}:${String(bucket.bucketEndSeconds)}`);
    expect(schedOrders).toBe(`tiktok-orders:${SHOP_UUID}:hora:2026-11-24T14`);
    expect(schedItems).toBe(`tiktok-items:${SHOP_UUID}:hora:2026-11-24T14`);
    expect(schedFin).toBe(`tiktok-financials:${SHOP_UUID}:hora:2026-11-24T14`);
    expect(fetchOrder).toBe(`tiktok-order-fetch:${SHOP_UUID}:576461413038785752:${String(bucket.bucketEndSeconds)}`);

    for (const key of [pushOrders, pushReturns, schedOrders, schedItems, schedFin, fetchOrder]) {
      const taskName = toTaskName(key);
      expect(taskName.length).toBeGreaterThan(0);
      expect(taskName.length).toBeLessThanOrEqual(200);
    }
  });

  it("falha fechado (RangeError) em Date inválida, janela não positiva, ID em branco ou hora inválida", () => {
    expect(() => tiktokPushWindowBucket(new Date("invalid"))).toThrow(RangeError);
    expect(() => tiktokPushWindowBucket(new Date("2026-11-24T12:00:00Z"), 0)).toThrow(RangeError);
    expect(() => tiktokPushWindowBucket(new Date("2026-11-24T12:00:00Z"), Number.NaN)).toThrow(RangeError);
    expect(() => tiktokPushDedupeKey("tiktok.orders.sync", "   ", 1700000000)).toThrow(RangeError);
    expect(() => tiktokPushDedupeKey("tiktok.orders.sync", SHOP_UUID, -1)).toThrow(RangeError);
    expect(() => tiktokScheduleDedupeKey("tiktok.orders.sync", SHOP_UUID, "2026-13-99T99")).toThrow(RangeError);
    expect(() => tiktokOrderFetchDedupeKey(SHOP_UUID, "   ", 1700000000)).toThrow(RangeError);
  });
});
