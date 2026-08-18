import assert from "node:assert/strict";
import { test } from "node:test";

import { runOperationalAlertBurst as processOperationalAlertBurst } from "@/features/stock/run-operational-alert-burst";

// ============================================================
// cenário 12 — o burst processa múltiplos jobs, não só um
// ============================================================

test("processa múltiplos jobs até a fila esvaziar", async () => {
  let calls = 0;
  const processJob = async () => {
    calls += 1;
    if (calls > 5) {
      return { processed: false, reason: "queue_empty" } as const;
    }
    return { processed: true, jobId: `job-${calls}`, result: { found: false, alerts: 0 } } as const;
  };

  const result = await processOperationalAlertBurst({ processJob });

  assert.equal(result.processedCount, 5);
  assert.equal(result.succeededCount, 5);
  assert.equal(result.failedCount, 0);
  assert.equal(calls, 6); // a 6ª chamada devolveu queue_empty e encerrou o loop
});

// ============================================================
// cenário 13 — falha de um job não interrompe o burst
// ============================================================

test("falha de um job não interrompe o processamento dos demais", async () => {
  let calls = 0;
  const processJob = async () => {
    calls += 1;
    if (calls === 2) {
      throw new Error("falha simulada na avaliação do produto");
    }
    if (calls > 4) {
      return { processed: false, reason: "queue_empty" } as const;
    }
    return { processed: true, jobId: `job-${calls}`, result: { found: false, alerts: 0 } } as const;
  };

  const result = await processOperationalAlertBurst({ processJob });

  assert.equal(result.processedCount, 4);
  assert.equal(result.succeededCount, 3);
  assert.equal(result.failedCount, 1);
});

// ============================================================
// cenário 14 — o orçamento de tempo encerra o burst com segurança
// ============================================================

test("encerra dentro do orçamento de tempo sem lançar erro", async () => {
  const processJob = async () => {
    // Simula custo real de I/O — sem isso, 1000 iterações triviais
    // terminariam antes mesmo do orçamento de tempo expirar.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { processed: true, jobId: "job-infinito", result: { found: false, alerts: 0 } } as const;
  };

  const result = await processOperationalAlertBurst({
    processJob,
    maxJobs: 1000,
    timeBudgetMs: 20,
  });

  assert.ok(result.processedCount > 0);
  assert.ok(result.processedCount < 1000, "deveria ter parado pelo orçamento de tempo, não pelo maxJobs");
  assert.ok(result.executionTimeMs < 1000);
});

test("fila vazia desde o início não processa nada", async () => {
  const processJob = async () => ({ processed: false, reason: "queue_empty" }) as const;

  const result = await processOperationalAlertBurst({ processJob });

  assert.equal(result.processed, false);
  assert.equal(result.processedCount, 0);
});
