import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeCancelRemainingQuantity,
  computeDefaultExpectedAt,
  computeEffectivePurchaseInTransit,
  computeInternalPurchaseInTransit,
  computeOutstandingQuantity,
  computeOverReceivedQuantity,
  deriveStatusAfterReceipt,
  isOverdue,
  isValidTransition,
} from "./purchase-order-domain";

test("computeOutstandingQuantity never goes negative", () => {
  assert.equal(computeOutstandingQuantity(10, 4, 0), 6);
  assert.equal(computeOutstandingQuantity(10, 4, 6), 0);
  assert.equal(computeOutstandingQuantity(10, 20, 0), 0);
});

test("computeOverReceivedQuantity reports overdelivery as a fact, never negative", () => {
  assert.equal(computeOverReceivedQuantity(10, 15), 5);
  assert.equal(computeOverReceivedQuantity(10, 5), 0);
});

test("isOverdue requires ordered/partially_received, an expected date, outstanding > 0 and the date to be past", () => {
  const now = new Date("2026-08-18T00:00:00Z");
  const past = new Date("2026-08-01T00:00:00Z");
  const future = new Date("2026-09-01T00:00:00Z");
  assert.equal(isOverdue("ordered", past, 5, now), true);
  assert.equal(isOverdue("ordered", future, 5, now), false);
  assert.equal(isOverdue("ordered", past, 0, now), false);
  assert.equal(isOverdue("draft", past, 5, now), false);
  assert.equal(isOverdue("received", past, 5, now), false);
  assert.equal(isOverdue("ordered", null, 5, now), false);
});

test("deriveStatusAfterReceipt: nothing received keeps ordered", () => {
  const status = deriveStatusAfterReceipt([{ quantityOrdered: 10, receivedQuantity: 0, cancelledQuantity: 0 }]);
  assert.equal(status, "ordered");
});

test("deriveStatusAfterReceipt: partial receipt across items is partially_received", () => {
  const status = deriveStatusAfterReceipt([
    { quantityOrdered: 10, receivedQuantity: 10, cancelledQuantity: 0 },
    { quantityOrdered: 10, receivedQuantity: 4, cancelledQuantity: 0 },
  ]);
  assert.equal(status, "partially_received");
});

test("deriveStatusAfterReceipt: full receipt is received", () => {
  const status = deriveStatusAfterReceipt([
    { quantityOrdered: 10, receivedQuantity: 10, cancelledQuantity: 0 },
    { quantityOrdered: 5, receivedQuantity: 6, cancelledQuantity: 0 },
  ]);
  assert.equal(status, "received");
});

test("deriveStatusAfterReceipt: received + cancelled covering the order counts as received", () => {
  const status = deriveStatusAfterReceipt([
    { quantityOrdered: 10, receivedQuantity: 4, cancelledQuantity: 6 },
  ]);
  assert.equal(status, "received");
});

test("computeCancelRemainingQuantity caps at ordered minus received", () => {
  assert.equal(computeCancelRemainingQuantity(10, 4), 6);
  assert.equal(computeCancelRemainingQuantity(10, 15), 0);
});

test("isValidTransition allows the documented status graph and rejects everything else", () => {
  assert.equal(isValidTransition("draft", "approved"), true);
  assert.equal(isValidTransition("approved", "draft"), true);
  assert.equal(isValidTransition("approved", "ordered"), true);
  assert.equal(isValidTransition("ordered", "partially_received"), true);
  assert.equal(isValidTransition("partially_received", "received"), true);
  assert.equal(isValidTransition("received", "draft"), false);
  assert.equal(isValidTransition("cancelled", "draft"), false);
  assert.equal(isValidTransition("draft", "ordered"), false);
});

test("computeDefaultExpectedAt adds the max lead time in calendar days", () => {
  const orderedAt = new Date("2026-08-18T12:00:00Z");
  const result = computeDefaultExpectedAt(orderedAt, 90);
  assert.equal(result.toISOString().slice(0, 10), "2026-11-16");
});

test("transit accounting: internal orders add to internal transit, upseller_confirmed does not double count", () => {
  // Ticket scenario 1: UpSeller transit 20, internal outstanding 30, mode internal -> effective 50.
  const internalOrders = [
    { status: "ordered" as const, transitAccountingSource: "internal" as const, outstandingQuantity: 30 },
  ];
  assert.equal(computeInternalPurchaseInTransit(internalOrders), 30);
  assert.equal(computeEffectivePurchaseInTransit(20, internalOrders), 50);

  // Ticket scenario 2: same order but upseller_confirmed -> effective stays 20.
  const confirmedOrders = [
    { status: "ordered" as const, transitAccountingSource: "upseller_confirmed" as const, outstandingQuantity: 30 },
  ];
  assert.equal(computeInternalPurchaseInTransit(confirmedOrders), 0);
  assert.equal(computeEffectivePurchaseInTransit(20, confirmedOrders), 20);
});

test("transit accounting: draft/approved orders never contribute, only ordered/partially_received do", () => {
  const draftOnly = [
    { status: "draft" as const, transitAccountingSource: "internal" as const, outstandingQuantity: 30 },
  ];
  assert.equal(computeInternalPurchaseInTransit(draftOnly), 0);

  const approvedOnly = [
    { status: "approved" as const, transitAccountingSource: "internal" as const, outstandingQuantity: 30 },
  ];
  assert.equal(computeInternalPurchaseInTransit(approvedOnly), 0);

  const orderedOnly = [
    { status: "ordered" as const, transitAccountingSource: "internal" as const, outstandingQuantity: 30 },
  ];
  assert.equal(computeInternalPurchaseInTransit(orderedOnly), 30);

  // Partially received: ordered 30, received 10 -> outstanding (internal transit) is 20.
  const partiallyReceived = [
    { status: "partially_received" as const, transitAccountingSource: "internal" as const, outstandingQuantity: 20 },
  ];
  assert.equal(computeInternalPurchaseInTransit(partiallyReceived), 20);

  // Fully received: outstanding is 0, contributes nothing.
  const received = [
    { status: "received" as const, transitAccountingSource: "internal" as const, outstandingQuantity: 0 },
  ];
  assert.equal(computeInternalPurchaseInTransit(received), 0);
});
