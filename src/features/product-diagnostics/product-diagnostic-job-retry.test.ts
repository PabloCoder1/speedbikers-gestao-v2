import assert from "node:assert/strict";
import { test } from "node:test";

import { retryDelaySeconds } from "./product-diagnostic-job-retry";

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
