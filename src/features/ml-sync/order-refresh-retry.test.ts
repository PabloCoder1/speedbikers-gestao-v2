import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyOrderFetchFailure,
  MercadoLivreOrderRequestError,
  parseRetryAfter,
} from "@/integrations/mercado-livre/order-error-classification";
import {
  shouldRequeueAfterRevisionBump,
  shouldRetryFetchWithinInvocation,
} from "@/features/ml-sync/order-refresh-decisions";

// ============================================================
// cenário 6 — 429 é retryable e respeita Retry-After
// ============================================================

test("429 é classificado como retryable", () => {
  const classification = classifyOrderFetchFailure(429);
  assert.equal(classification.retryable, true);
  assert.equal(classification.notFound, false);
});

test("Retry-After é lido em segundos quando presente e válido", () => {
  assert.equal(parseRetryAfter("7"), 7);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter("not-a-number"), null);
  assert.equal(parseRetryAfter("-1"), null);
});

test("5xx também é retryable", () => {
  assert.equal(classifyOrderFetchFailure(503).retryable, true);
});

test("404 é retryable (consistência eventual) e marcado como notFound", () => {
  const classification = classifyOrderFetchFailure(404);
  assert.equal(classification.retryable, true);
  assert.equal(classification.notFound, true);
});

test("401/403 não são retryable — erro de autenticação/permissão", () => {
  assert.equal(classifyOrderFetchFailure(401).retryable, false);
  assert.equal(classifyOrderFetchFailure(403).retryable, false);
});

// ============================================================
// cenário 6/7 — orçamento de retry dentro de uma única invocação
// ============================================================

test("shouldRetryFetchWithinInvocation permite novas tentativas para erro retryable dentro do orçamento", () => {
  const error = new MercadoLivreOrderRequestError(
    "ORDER_HTTP_429",
    429,
    null,
    null,
    true,
    false,
    null,
  );

  assert.equal(shouldRetryFetchWithinInvocation({ error, fetchAttempt: 1 }), true);
  assert.equal(shouldRetryFetchWithinInvocation({ error, fetchAttempt: 2 }), true);
});

test("shouldRetryFetchWithinInvocation esgota no máximo de tentativas (cenário 7)", () => {
  const error = new MercadoLivreOrderRequestError(
    "ORDER_HTTP_429",
    429,
    null,
    null,
    true,
    false,
    null,
  );

  // MAX_FETCH_ATTEMPTS = 3: a terceira tentativa que falhou não deve
  // gerar uma quarta — o job volta para a fila via attempt_count/backoff.
  assert.equal(shouldRetryFetchWithinInvocation({ error, fetchAttempt: 3 }), false);
});

test("shouldRetryFetchWithinInvocation não retenta erro não-retryable (401/403)", () => {
  const error = new MercadoLivreOrderRequestError(
    "ORDER_HTTP_401",
    401,
    null,
    null,
    false,
    false,
    null,
  );

  assert.equal(shouldRetryFetchWithinInvocation({ error, fetchAttempt: 1 }), false);
});

// ============================================================
// cenários 4/5 — nova revisão chegou durante o processamento
// ============================================================

test("shouldRequeueAfterRevisionBump: revisão avançou durante o processamento => true", () => {
  assert.equal(
    shouldRequeueAfterRevisionBump({ capturedRevision: 1, currentRevision: 2 }),
    true,
  );
});

test("shouldRequeueAfterRevisionBump: nenhuma notificação nova chegou => false", () => {
  assert.equal(
    shouldRequeueAfterRevisionBump({ capturedRevision: 3, currentRevision: 3 }),
    false,
  );
});
