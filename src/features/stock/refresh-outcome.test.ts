import assert from "node:assert/strict";
import { test } from "node:test";

import { describeRefreshOutcome } from "@/features/stock/refresh-outcome";

// ============================================================
// cenário 10 — o worker nunca falha só porque o refresh pulou ou
// deu erro. describeRefreshOutcome nunca sinaliza "throw" — só
// devolve uma mensagem de log ou null.
// ============================================================

test("erro de RPC gera mensagem de log, nunca uma exceção", () => {
  const message = describeRefreshOutcome(null, { message: "boom" });
  assert.equal(typeof message, "string");
  assert.ok(message?.includes("failed"));
});

// ============================================================
// cenário 8 — refresh já em andamento (already_running) é reportado,
// não é um erro fatal
// ============================================================

test("refreshed:false com reason already_running é logado, não é erro", () => {
  const message = describeRefreshOutcome(
    { refreshed: false, reason: "already_running" },
    null,
  );
  assert.ok(message?.includes("already_running"));
});

// ============================================================
// cenário 9 — concurrent_refresh_failed também é apenas logado, nunca
// dispara um refresh bloqueante (essa decisão é do lado SQL — aqui só
// confirmamos que o lado TS trata o resultado como não fatal)
// ============================================================

test("refreshed:false com reason concurrent_refresh_failed é logado, não é erro", () => {
  const message = describeRefreshOutcome(
    { refreshed: false, reason: "concurrent_refresh_failed", error: "some pg error" },
    null,
  );
  assert.ok(message?.includes("concurrent_refresh_failed"));
});

test("refreshed:true não gera nenhuma mensagem", () => {
  const message = describeRefreshOutcome(
    { refreshed: true, mode: "concurrent", rows: 92, elapsedMs: 40 },
    null,
  );
  assert.equal(message, null);
});

test("payload inesperado (nem erro, nem refreshed:false) não gera mensagem", () => {
  assert.equal(describeRefreshOutcome({}, null), null);
  assert.equal(describeRefreshOutcome(null, null), null);
});
