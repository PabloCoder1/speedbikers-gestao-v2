import assert from "node:assert/strict";
import { test } from "node:test";

import { runOrderRefreshBurst as processOrderRefreshBurst } from "@/features/ml-sync/run-order-refresh-burst";

// ============================================================
// cenário 11 — um único refresh de stock deductions por burst,
// mesmo processando vários pedidos alterados
// ============================================================

test("chama refresh_stock_sale_deductions no máximo uma vez, mesmo com vários pedidos alterados", async () => {
  let calls = 0;
  const processJob = async () => {
    calls += 1;
    if (calls > 5) {
      return { processed: false, reason: "queue_empty" } as const;
    }
    return {
      processed: true,
      status: "succeeded",
      orderId: `order-${calls}`,
      changed: true,
    } as const;
  };

  let refreshCalls = 0;
  const refreshDeductions = async () => {
    refreshCalls += 1;
  };

  const result = await processOrderRefreshBurst({ processJob, refreshDeductions });

  assert.equal(result.processedCount, 5);
  assert.equal(refreshCalls, 1);
  assert.equal(result.stockDeductionsRefreshed, true);
});

test("não chama refresh_stock_sale_deductions quando nada mudou", async () => {
  let calls = 0;
  const processJob = async () => {
    calls += 1;
    if (calls > 3) {
      return { processed: false, reason: "queue_empty" } as const;
    }
    return {
      processed: true,
      status: "requeued",
      orderId: `order-${calls}`,
      changed: false,
    } as const;
  };

  let refreshCalls = 0;
  const refreshDeductions = async () => {
    refreshCalls += 1;
  };

  const result = await processOrderRefreshBurst({ processJob, refreshDeductions });

  assert.equal(refreshCalls, 0);
  assert.equal(result.stockDeductionsRefreshed, false);
});

test("falha de um job não interrompe o burst de order_refresh", async () => {
  let calls = 0;
  const processJob = async () => {
    calls += 1;
    if (calls === 2) {
      throw new Error("falha simulada ao buscar o pedido");
    }
    if (calls > 4) {
      return { processed: false, reason: "queue_empty" } as const;
    }
    return {
      processed: true,
      status: "succeeded",
      orderId: `order-${calls}`,
      changed: true,
    } as const;
  };

  const result = await processOrderRefreshBurst({
    processJob,
    refreshDeductions: async () => {},
  });

  assert.equal(result.processedCount, 4);
  assert.equal(result.succeededCount, 3);
  assert.equal(result.failedCount, 1);
});
