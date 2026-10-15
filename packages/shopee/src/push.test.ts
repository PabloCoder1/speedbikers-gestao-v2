import { describe, expect, it } from "vitest";

import { shopeePushSchema, signPush, verifyPushSignature } from "./push.js";

const CHAVE = "chave-de-teste-nao-real";
const URL_PUSH = "https://api.speedbikers.test/push/shopee";
// O exemplo oficial do `order_status_push`, como chega (corpo cru).
const CORPO =
  '{"data":{"items":[],"ordersn":"220810QSK8S7BX","status":"PROCESSED","completed_scenario":"","update_time":1660123127},"shop_id":727720655,"code":3,"timestamp":1660123127}';
// HMAC-SHA256 de `URL|CORPO` calculado à parte (Python hmac), não por esta função.
const ASSINATURA = "119a7a82d0cd3fa370c166864cad95b4f4db062b68f8e496106156ff951253d7";

describe("push da Shopee (D-453)", () => {
  it("assina `endereço|corpo cru` com a chave do parceiro", () => {
    expect(signPush(CHAVE, URL_PUSH, CORPO)).toBe(ASSINATURA);
  });

  it("aceita a assinatura certa (em maiúsculas também) e recusa o resto", () => {
    expect(verifyPushSignature(CHAVE, URL_PUSH, CORPO, ASSINATURA)).toBe(true);
    expect(verifyPushSignature(CHAVE, URL_PUSH, CORPO, ASSINATURA.toUpperCase())).toBe(true);
    // Outro endereço, corpo reserializado, outra chave, ausente ou malformada.
    expect(verifyPushSignature(CHAVE, "https://api.speedbikers.test/push/shopee/", CORPO, ASSINATURA)).toBe(false);
    expect(verifyPushSignature(CHAVE, URL_PUSH, JSON.stringify(JSON.parse(CORPO) as unknown, null, 1), ASSINATURA)).toBe(false);
    expect(verifyPushSignature("outra-chave-de-teste-nao-real", URL_PUSH, CORPO, ASSINATURA)).toBe(false);
    expect(verifyPushSignature(CHAVE, URL_PUSH, CORPO, undefined)).toBe(false);
    expect(verifyPushSignature(CHAVE, URL_PUSH, CORPO, "abc")).toBe(false);
  });

  it("lê o envelope dos exemplos oficiais, guardando o resto", () => {
    expect(shopeePushSchema.parse(JSON.parse(CORPO))).toMatchObject({ code: 3, shop_id: 727720655, timestamp: 1660123127 });
    // `shop_authorization_canceled_push` vem sem `shop_id` no envelope.
    expect(
      shopeePushSchema.parse({ data: { authorize_type: "expiry", shopid: 22000000, success: 1 }, code: 2, partner_id: 800000, timestamp: 1653026985 }),
    ).toMatchObject({ code: 2, partner_id: 800000 });
    expect(shopeePushSchema.safeParse({ shop_id: 1 }).success).toBe(false);
  });
});
