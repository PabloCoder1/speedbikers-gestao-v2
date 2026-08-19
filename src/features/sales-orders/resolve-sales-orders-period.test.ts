import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isValidDateKey,
  periodToIsoRange,
  resolveSalesOrdersPeriod,
} from "./resolve-sales-orders-period";

test("preset 'today' resolves to a single-day range", () => {
  const period = resolveSalesOrdersPeriod({ preset: "today", today: "2026-08-19" });
  assert.deepEqual(period, { preset: "today", fromDateKey: "2026-08-19", toDateKey: "2026-08-19" });
});

test("missing/unknown preset defaults to 'today'", () => {
  const period = resolveSalesOrdersPeriod({ preset: undefined, today: "2026-08-19" });
  assert.equal(period.preset, "today");
});

test("preset 'yesterday' resolves to the single previous day", () => {
  const period = resolveSalesOrdersPeriod({ preset: "yesterday", today: "2026-08-19" });
  assert.deepEqual(period, { preset: "yesterday", fromDateKey: "2026-08-18", toDateKey: "2026-08-18" });
});

test("preset '7d' spans 7 calendar days ending today (inclusive)", () => {
  const period = resolveSalesOrdersPeriod({ preset: "7d", today: "2026-08-19" });
  assert.equal(period.fromDateKey, "2026-08-13");
  assert.equal(period.toDateKey, "2026-08-19");
});

test("preset '30d' spans 30 calendar days ending today (inclusive)", () => {
  const period = resolveSalesOrdersPeriod({ preset: "30d", today: "2026-08-19" });
  assert.equal(period.fromDateKey, "2026-07-21");
  assert.equal(period.toDateKey, "2026-08-19");
});

test("preset 'custom' with a valid range is honored as-is", () => {
  const period = resolveSalesOrdersPeriod({
    preset: "custom",
    today: "2026-08-19",
    customFrom: "2026-08-01",
    customTo: "2026-08-10",
  });
  assert.deepEqual(period, { preset: "custom", fromDateKey: "2026-08-01", toDateKey: "2026-08-10" });
});

test("preset 'custom' clamps a future toDate down to today", () => {
  const period = resolveSalesOrdersPeriod({
    preset: "custom",
    today: "2026-08-19",
    customFrom: "2026-08-01",
    customTo: "2026-12-31",
  });
  assert.equal(period.toDateKey, "2026-08-19");
});

test("preset 'custom' with fromDate after toDate falls back to 'today'", () => {
  const period = resolveSalesOrdersPeriod({
    preset: "custom",
    today: "2026-08-19",
    customFrom: "2026-08-10",
    customTo: "2026-08-01",
  });
  assert.equal(period.preset, "today");
});

test("preset 'custom' with invalid date keys falls back to 'today'", () => {
  const period = resolveSalesOrdersPeriod({
    preset: "custom",
    today: "2026-08-19",
    customFrom: "not-a-date",
    customTo: "2026-08-01",
  });
  assert.equal(period.preset, "today");
});

test("isValidDateKey rejects calendar-impossible dates", () => {
  assert.equal(isValidDateKey("2026-02-30"), false);
  assert.equal(isValidDateKey("2026-08-19"), true);
  assert.equal(isValidDateKey("2026-8-19"), false);
  assert.equal(isValidDateKey(null), false);
});

test("periodToIsoRange produces a Sao Paulo midnight-to-midnight instant range", () => {
  const range = periodToIsoRange({ fromDateKey: "2026-08-19", toDateKey: "2026-08-19" });
  // Sao Paulo is UTC-3 (no DST currently observed) -> 2026-08-19T00:00 SP = 2026-08-19T03:00Z
  assert.equal(range.fromIso, "2026-08-19T03:00:00.000Z");
  // exclusive upper bound is the START of the NEXT day
  assert.equal(range.toIsoExclusive, "2026-08-20T03:00:00.000Z");
});

test("periodToIsoRange spans multiple days correctly (7d-style range)", () => {
  const range = periodToIsoRange({ fromDateKey: "2026-08-13", toDateKey: "2026-08-19" });
  assert.equal(range.fromIso, "2026-08-13T03:00:00.000Z");
  assert.equal(range.toIsoExclusive, "2026-08-20T03:00:00.000Z");
});
