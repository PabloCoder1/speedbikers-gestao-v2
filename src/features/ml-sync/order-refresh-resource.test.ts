import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { resourceTarget } from "@/features/ml-sync/notification-resource";

// ============================================================
// orders_v2 — parsing do resource (cenários 1 e 2 da ETAPA 32)
// ============================================================

test("orders_v2: resource válido extrai o orderId como string", () => {
  const target = resourceTarget("orders_v2", "/orders/2000012345678901");

  assert.ok(target);
  assert.equal(target.orderId, "2000012345678901");
  assert.equal(typeof target.orderId, "string");
  assert.equal(target.itemId, null);
  assert.equal(target.offerId, null);
  assert.equal(target.operationId, null);
});

test("orders_v2: resource inválido (sem id) é rejeitado", () => {
  assert.equal(resourceTarget("orders_v2", "/orders/"), null);
});

test("orders_v2: resource com sufixo extra é rejeitado", () => {
  assert.equal(resourceTarget("orders_v2", "/orders/123/extra"), null);
});

test("orders_v2: resource de outro recurso é rejeitado", () => {
  assert.equal(resourceTarget("orders_v2", "/items/MLB123"), null);
});

test("items_prices e fbm_stock_operations continuam funcionando após adicionar orders_v2", () => {
  const priceTarget = resourceTarget("items_prices", "/items/MLB123456789");
  assert.ok(priceTarget);
  assert.equal(priceTarget.itemId, "MLB123456789");
  assert.equal(priceTarget.orderId, null);

  const fulfillmentTarget = resourceTarget(
    "fbm_stock_operations",
    "/stock/fulfillment/operations/op-1",
  );
  assert.ok(fulfillmentTarget);
  assert.equal(fulfillmentTarget.operationId, "op-1");
  assert.equal(fulfillmentTarget.orderId, null);
});

// ============================================================
// cenário 8 — o webhook não faz nenhuma chamada de API do Mercado
// Livre. Verificação estrutural: o módulo do webhook nunca importa o
// client HTTP de orders/fulfillment/offers, então é estruturalmente
// impossível ele fazer GET /orders por engano.
// ============================================================

test("ingest-mercado-livre-notification.ts não importa clients HTTP do Mercado Livre", () => {
  const filePath = path.join(
    process.cwd(),
    "src/features/ml-sync/ingest-mercado-livre-notification.ts",
  );
  const source = readFileSync(filePath, "utf8");

  assert.ok(
    !/from ["']@\/integrations\/mercado-livre\/(orders|fulfillment|offers)["']/.test(
      source,
    ),
    "o webhook não deve importar clients HTTP do Mercado Livre — só enfileira via admin.rpc(...)",
  );
  assert.ok(
    !/\bfetch\(/.test(source),
    "o webhook não deve chamar fetch diretamente",
  );
});
