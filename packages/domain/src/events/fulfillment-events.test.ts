import { describe, expect, it } from "vitest";

import { detectFulfillmentEvents } from "./fulfillment-events.js";
import type { FulfillmentCapture } from "./fulfillment-events.js";

const CAPTURED_AT = new Date("2026-08-22T13:00:00.000Z");

function capture(overrides: Partial<FulfillmentCapture> = {}): FulfillmentCapture {
  return {
    inventoryId: "INV-1",
    skuId: "sku-1",
    quantity: 10,
    capturedAt: CAPTURED_AT,
    ...overrides,
  };
}

describe("detectFulfillmentEvents", () => {
  it("primeira captura vista (previous null): emite listing.fulfillment.entered", () => {
    const events = detectFulfillmentEvents(null, capture());

    expect(events).toEqual([
      {
        eventType: "listing.fulfillment.entered",
        entityType: "listing",
        entityId: "INV-1",
        before: null,
        after: { quantity: 10 },
        severity: "importante",
        source: "sync",
        dedupKey: "listing.fulfillment.entered:INV-1:2026-08-22T13:00:00.000Z",
        occurredAt: CAPTURED_AT,
      },
    ]);
  });

  it("primeira captura já com saldo zero: entered + stock.depleted juntos", () => {
    const events = detectFulfillmentEvents(null, capture({ quantity: 0 }));

    expect(events.map((e) => e.eventType)).toEqual(["listing.fulfillment.entered", "stock.depleted"]);
  });

  it("quantidade positiva em ambas as capturas: nenhum evento", () => {
    const previous = capture({ quantity: 10 });
    const events = detectFulfillmentEvents(previous, capture({ quantity: 7 }));

    expect(events).toEqual([]);
  });

  it("quantidade cai para zero: emite stock.depleted", () => {
    const previous = capture({ quantity: 3 });
    const events = detectFulfillmentEvents(previous, capture({ quantity: 0 }));

    expect(events).toEqual([
      {
        eventType: "stock.depleted",
        entityType: "sku",
        entityId: "sku-1",
        before: { quantity: 3 },
        after: { quantity: 0 },
        severity: "critico",
        source: "sync",
        dedupKey: "stock.depleted:full:INV-1:2026-08-22T13:00:00.000Z",
        occurredAt: CAPTURED_AT,
      },
    ]);
  });

  it("permanece zerado (zero -> zero): não reemite stock.depleted", () => {
    const previous = capture({ quantity: 0 });
    const events = detectFulfillmentEvents(previous, capture({ quantity: 0 }));

    expect(events).toEqual([]);
  });

  it("sai de zero para positivo: emite stock.replenished", () => {
    const previous = capture({ quantity: 0 });
    const events = detectFulfillmentEvents(previous, capture({ quantity: 5 }));

    expect(events).toEqual([
      {
        eventType: "stock.replenished",
        entityType: "sku",
        entityId: "sku-1",
        before: { quantity: 0 },
        after: { quantity: 5 },
        severity: "informativo",
        source: "sync",
        dedupKey: "stock.replenished:full:INV-1:2026-08-22T13:00:00.000Z",
        occurredAt: CAPTURED_AT,
      },
    ]);
  });

  it("dedup_key inclui captured_at — uma nova depleção depois de repor gera chave diferente da anterior", () => {
    const firstDepleted = detectFulfillmentEvents(capture({ quantity: 3 }), capture({ quantity: 0 }));
    const laterDepleted = detectFulfillmentEvents(
      capture({ quantity: 5, capturedAt: new Date("2026-09-01T00:00:00.000Z") }),
      capture({ quantity: 0, capturedAt: new Date("2026-09-02T00:00:00.000Z") }),
    );

    expect(firstDepleted[0]?.dedupKey).not.toBe(laterDepleted[0]?.dedupKey);
  });

  it("reprocessar o MESMO par de capturas produz a MESMA chave — idempotente", () => {
    const previous = capture({ quantity: 3 });
    const current = capture({ quantity: 0 });

    const first = detectFulfillmentEvents(previous, current);
    const second = detectFulfillmentEvents(previous, current);

    expect(first[0]?.dedupKey).toBe(second[0]?.dedupKey);
  });
});
