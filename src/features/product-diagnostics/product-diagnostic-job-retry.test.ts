import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveJobOutcomeAction, retryDelaySeconds } from "./product-diagnostic-job-retry";

// 29. worker failure => retry seguro (bounded, increasing backoff, never runs away)
test("retry delay grows with attempt count and is capped at 15 minutes", () => {
  const first = retryDelaySeconds(1);
  const second = retryDelaySeconds(2);
  assert.ok(first >= 30 && first <= 46);
  assert.ok(second >= 60 && second <= 76);
  assert.ok(retryDelaySeconds(20) <= 900);
});

test("retry delay never goes negative for attempt 0", () => {
  assert.ok(retryDelaySeconds(0) >= 30);
});

// 9 (hotfix). V2 succeeded => job succeeded
test("a successful diagnostic run makes the job succeeded, regardless of retryable", () => {
  assert.equal(resolveJobOutcomeAction({ diagnosticSucceeded: true, retryable: false }), "succeeded");
  assert.equal(resolveJobOutcomeAction({ diagnosticSucceeded: true, retryable: true }), "succeeded");
});

// 10 (hotfix). V2 failed => job failed/retry, nunca succeeded enganoso
test("a failed diagnostic run never makes the job succeeded — it retries (transient) or fails (structural)", () => {
  assert.equal(resolveJobOutcomeAction({ diagnosticSucceeded: false, retryable: true }), "retry_or_fail");
  assert.equal(resolveJobOutcomeAction({ diagnosticSucceeded: false, retryable: false }), "failed_non_retryable");
});
