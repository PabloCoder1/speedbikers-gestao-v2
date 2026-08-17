import assert from "node:assert/strict";
import test from "node:test";

import {
  nextSaoPauloDayStartIso,
  saoPauloDateKey,
  saoPauloStartOfDayIso,
  shiftSaoPauloDateKey,
} from "./sao-paulo";

test("uses the Sao Paulo calendar day instead of the UTC day", () => {
  assert.equal(saoPauloDateKey("2026-08-18T01:30:00.000Z"), "2026-08-17");
  assert.equal(saoPauloStartOfDayIso("2026-08-17"), "2026-08-17T03:00:00.000Z");
  assert.equal(nextSaoPauloDayStartIso("2026-08-18T01:30:00.000Z"), "2026-08-18T03:00:00.000Z");
});

test("shifts date-only values without changing calendar semantics", () => {
  assert.equal(shiftSaoPauloDateKey("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftSaoPauloDateKey("2024-02-28", 1), "2024-02-29");
});

test("respects historical Sao Paulo daylight-saving offsets", () => {
  assert.equal(saoPauloStartOfDayIso("2018-12-01"), "2018-12-01T02:00:00.000Z");
});
