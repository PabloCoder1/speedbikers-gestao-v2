import { describe, expect, it } from "vitest";

import {
  WEBHOOK_CANCELLATION_STATUS_CHANGE,
  WEBHOOK_INVOICE_STATUS_CHANGE,
  WEBHOOK_ORDER_STATUS_CHANGE,
  WEBHOOK_RETURN_STATUS_CHANGE,
  WEBHOOK_SELLER_DEAUTHORIZATION,
  WEBHOOK_UPCOMING_AUTHORIZATION_EXPIRATION,
  parseTikTokWebhookData,
  signWebhook,
  tiktokWebhookSchema,
  verifyWebhookSignature,
} from "./webhook.js";

const APP_KEY = "68xu9ks5p4i8";
const APP_SECRET = "segredo-webhook-teste";

describe("webhook do TikTok Shop (§10)", () => {
  it("calcula HMAC-SHA256 hex minúsculo de app_key + corpo bruto e verifica em tempo constante", () => {
    const rawBody =
      '{"type":1,"tts_notification_id":"7327112393057371910","shop_id":"7494049642642441621","timestamp":1644412885,"data":{"order_id":"576461413038785752","order_status":"AWAITING_SHIPMENT","is_on_hold_order":false,"update_time":1644412885}}';
    const assinatura = signWebhook(APP_SECRET, APP_KEY, rawBody);

    expect(assinatura).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(APP_SECRET, APP_KEY, rawBody, assinatura)).toBe(true);
    expect(verifyWebhookSignature(APP_SECRET, APP_KEY, rawBody, assinatura.toUpperCase())).toBe(true);
  });

  it("rejeita assinatura ausente, com prefixo Bearer, alterada, corpo modificado ou segredo/chave vazios", () => {
    const rawBody = '{"type":1,"tts_notification_id":"n1","shop_id":"123","timestamp":1700000000,"data":{}}';
    const assinatura = signWebhook(APP_SECRET, APP_KEY, rawBody);

    expect(verifyWebhookSignature(APP_SECRET, APP_KEY, rawBody, undefined)).toBe(false);
    expect(verifyWebhookSignature(APP_SECRET, APP_KEY, rawBody, "")).toBe(false);
    expect(verifyWebhookSignature(APP_SECRET, APP_KEY, rawBody, `Bearer ${assinatura}`)).toBe(false);
    expect(verifyWebhookSignature(APP_SECRET, APP_KEY, `${rawBody} `, assinatura)).toBe(false);
    expect(verifyWebhookSignature(APP_SECRET, "outra-chave", rawBody, assinatura)).toBe(false);
    expect(verifyWebhookSignature("outro-segredo", APP_KEY, rawBody, assinatura)).toBe(false);
    expect(verifyWebhookSignature("", APP_KEY, rawBody, assinatura)).toBe(false);
    expect(verifyWebhookSignature(APP_SECRET, "", rawBody, assinatura)).toBe(false);
    expect(verifyWebhookSignature(APP_SECRET, APP_KEY, rawBody, "zzzz".repeat(16))).toBe(false);
  });

  it("valida envelope com type numérico ou textual, shop_id textual/numérico e recusa campos inválidos", () => {
    expect(WEBHOOK_ORDER_STATUS_CHANGE).toBe(1);
    expect(WEBHOOK_SELLER_DEAUTHORIZATION).toBe(6);
    expect(WEBHOOK_UPCOMING_AUTHORIZATION_EXPIRATION).toBe(7);
    expect(WEBHOOK_CANCELLATION_STATUS_CHANGE).toBe(11);
    expect(WEBHOOK_RETURN_STATUS_CHANGE).toBe(12);
    expect(WEBHOOK_INVOICE_STATUS_CHANGE).toBe(36);

    const parsed = tiktokWebhookSchema.parse({
      type: "1",
      tts_notification_id: " 7327112393057371910 ",
      shop_id: 7494049642642,
      timestamp: "1700000000",
      data: { order_id: "576461413038785752", order_status: "CANCEL", update_time: 1700000001 },
    });

    expect(parsed.type).toBe(1);
    expect(parsed.tts_notification_id).toBe("7327112393057371910");
    expect(parsed.shop_id).toBe("7494049642642");
    expect(parsed.timestamp).toBe(1700000000);

    expect(tiktokWebhookSchema.safeParse({ type: 1, tts_notification_id: "   " }).success).toBe(false);
    expect(tiktokWebhookSchema.safeParse({ type: 1, tts_notification_id: "n1", shop_id: "abc" }).success).toBe(false);
    expect(tiktokWebhookSchema.safeParse({ type: 1, tts_notification_id: "n1", shop_id: 0 }).success).toBe(false);
    expect(
      tiktokWebhookSchema.safeParse({ type: 1, tts_notification_id: "n1", timestamp: 9_000_000_000_000 }).success,
    ).toBe(false);
  });

  it("interpreta payloads tipados por evento sem confiar em campos ausentes", () => {
    const order = parseTikTokWebhookData(WEBHOOK_ORDER_STATUS_CHANGE, {
      order_id: "576461413038785752",
      order_status: "AWAITING_SHIPMENT",
      is_on_hold_order: false,
      update_time: 1700000001,
    });

    expect(order).toEqual({
      kind: "order_status_change",
      orderId: "576461413038785752",
      orderStatus: "AWAITING_SHIPMENT",
      isOnHoldOrder: false,
      updateTime: 1700000001,
    });

    const cancel = parseTikTokWebhookData(WEBHOOK_CANCELLATION_STATUS_CHANGE, {
      cancel_id: "c-1",
      order_id: "o-1",
      cancel_status: "CANCELLATION_REQUEST_COMPLETE",
      update_time: 1700000002,
    });

    expect(cancel).toEqual({
      kind: "cancellation_status_change",
      cancelId: "c-1",
      orderId: "o-1",
      cancelStatus: "CANCELLATION_REQUEST_COMPLETE",
      updateTime: 1700000002,
    });

    const ret = parseTikTokWebhookData(WEBHOOK_RETURN_STATUS_CHANGE, {
      return_id: "r-1",
      order_id: "o-1",
      return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
      update_time: 1700000003,
    });

    expect(ret).toEqual({
      kind: "return_status_change",
      returnId: "r-1",
      orderId: "o-1",
      returnStatus: "RETURN_OR_REFUND_REQUEST_PENDING",
      updateTime: 1700000003,
    });

    expect(parseTikTokWebhookData(WEBHOOK_ORDER_STATUS_CHANGE, { order_id: "" })).toBeNull();
    expect(parseTikTokWebhookData(999, { foo: "bar" })).toBeNull();
  });
});
