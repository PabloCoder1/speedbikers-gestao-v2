import assert from "node:assert/strict";
import { test } from "node:test";

import { isPriceToWinContextValid } from "./price-to-win-normalization";

// 6. missing price => null (via an invalid context — see diagnostics.ts, which gates on this)
// 7. missing price_to_win => null
test("a listing with no currency and status=unknown (no real competition context) is never treated as having a valid price", () => {
  assert.equal(isPriceToWinContextValid({ currencyId: null, status: "unknown" }), false);
});

test("a listing with a real currency and a real status is treated as having a valid price context", () => {
  assert.equal(isPriceToWinContextValid({ currencyId: "BRL", status: "competing" }), true);
});

test("a listing with a currency but status=unknown is still not trusted (partial context is not enough)", () => {
  assert.equal(isPriceToWinContextValid({ currencyId: "BRL", status: "unknown" }), false);
});

test("a listing with a real status but no currency is still not trusted", () => {
  assert.equal(isPriceToWinContextValid({ currencyId: null, status: "winning" }), false);
});
