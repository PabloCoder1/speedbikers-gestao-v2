import { describe, expect, it } from "vitest";

import { detectListingEvents } from "./listing-events.js";
import type { ListingSnapshot } from "./listing-events.js";

const SYNCED_AT = new Date("2026-08-24T18:00:00.000Z");

function snapshot(overrides: Partial<ListingSnapshot> = {}): ListingSnapshot {
  return {
    itemId: "MLB123",
    title: "Kit relação Honda CG 160",
    status: "active",
    price: 399.9,
    availableQuantity: 10,
    ...overrides,
  };
}

describe("detectListingEvents", () => {
  it("primeira sincronização (previous null): nenhum evento", () => {
    const events = detectListingEvents(null, snapshot(), SYNCED_AT);

    expect(events).toEqual([]);
  });

  it("nada mudou: nenhum evento", () => {
    const previous = snapshot();
    const events = detectListingEvents(previous, snapshot(), SYNCED_AT);

    expect(events).toEqual([]);
  });

  it("preço mudou: emite listing.price.changed com severidade informativo", () => {
    const previous = snapshot({ price: 399.9 });
    const events = detectListingEvents(previous, snapshot({ price: 379.9 }), SYNCED_AT);

    expect(events).toEqual([
      {
        eventType: "listing.price.changed",
        entityType: "listing",
        entityId: "MLB123",
        before: { price: 399.9 },
        after: { price: 379.9 },
        severity: "informativo",
        source: "sync",
        dedupKey: "listing.price.changed:MLB123:2026-08-24T18:00:00.000Z",
        occurredAt: SYNCED_AT,
      },
    ]);
  });

  it("título mudou: emite listing.title.changed", () => {
    const previous = snapshot({ title: "Título antigo" });
    const events = detectListingEvents(previous, snapshot({ title: "Título novo" }), SYNCED_AT);

    expect(events).toEqual([
      {
        eventType: "listing.title.changed",
        entityType: "listing",
        entityId: "MLB123",
        before: { title: "Título antigo" },
        after: { title: "Título novo" },
        severity: "informativo",
        source: "sync",
        dedupKey: "listing.title.changed:MLB123:2026-08-24T18:00:00.000Z",
        occurredAt: SYNCED_AT,
      },
    ]);
  });

  it("available_quantity mudou (sem cruzar zero): emite listing.available_quantity.changed", () => {
    const previous = snapshot({ availableQuantity: 10 });
    const events = detectListingEvents(previous, snapshot({ availableQuantity: 4 }), SYNCED_AT);

    expect(events).toEqual([
      {
        eventType: "listing.available_quantity.changed",
        entityType: "listing",
        entityId: "MLB123",
        before: { availableQuantity: 10 },
        after: { availableQuantity: 4 },
        severity: "informativo",
        source: "sync",
        dedupKey: "listing.available_quantity.changed:MLB123:2026-08-24T18:00:00.000Z",
        occurredAt: SYNCED_AT,
      },
    ]);
  });

  it("status active -> paused: emite listing.status.paused com severidade importante", () => {
    const previous = snapshot({ status: "active" });
    const events = detectListingEvents(previous, snapshot({ status: "paused" }), SYNCED_AT);

    expect(events).toEqual([
      {
        eventType: "listing.status.paused",
        entityType: "listing",
        entityId: "MLB123",
        before: { status: "active" },
        after: { status: "paused" },
        severity: "importante",
        source: "sync",
        dedupKey: "listing.status.paused:MLB123:2026-08-24T18:00:00.000Z",
        occurredAt: SYNCED_AT,
      },
    ]);
  });

  it("status paused -> active: emite listing.status.reactivated com severidade informativo", () => {
    const previous = snapshot({ status: "paused" });
    const events = detectListingEvents(previous, snapshot({ status: "active" }), SYNCED_AT);

    expect(events).toEqual([
      {
        eventType: "listing.status.reactivated",
        entityType: "listing",
        entityId: "MLB123",
        before: { status: "paused" },
        after: { status: "active" },
        severity: "informativo",
        source: "sync",
        dedupKey: "listing.status.reactivated:MLB123:2026-08-24T18:00:00.000Z",
        occurredAt: SYNCED_AT,
      },
    ]);
  });

  it("status paused -> closed: nenhuma das duas transições catalogadas, nenhum evento", () => {
    const previous = snapshot({ status: "paused" });
    const events = detectListingEvents(previous, snapshot({ status: "closed" }), SYNCED_AT);

    expect(events).toEqual([]);
  });

  it("status active -> under_review: nenhuma das duas transições catalogadas, nenhum evento", () => {
    const previous = snapshot({ status: "active" });
    const events = detectListingEvents(previous, snapshot({ status: "under_review" }), SYNCED_AT);

    expect(events).toEqual([]);
  });

  it("estoque zera e o anúncio pausa sozinho: os dois eventos disparam juntos", () => {
    const previous = snapshot({ status: "active", availableQuantity: 3 });
    const current = snapshot({ status: "paused", availableQuantity: 0 });

    const events = detectListingEvents(previous, current, SYNCED_AT);

    expect(events.map((event) => event.eventType)).toEqual([
      "listing.available_quantity.changed",
      "listing.status.paused",
    ]);
  });

  it("múltiplos campos mudam juntos: um evento por campo, todos na mesma sincronização", () => {
    const previous = snapshot({ price: 100, title: "Antigo", availableQuantity: 5, status: "active" });
    const current = snapshot({ price: 90, title: "Novo", availableQuantity: 2, status: "active" });

    const events = detectListingEvents(previous, current, SYNCED_AT);

    expect(events.map((event) => event.eventType)).toEqual([
      "listing.price.changed",
      "listing.title.changed",
      "listing.available_quantity.changed",
    ]);
  });

  it("reprocessar o MESMO par de estados produz a MESMA chave — idempotente", () => {
    const previous = snapshot({ price: 100 });
    const current = snapshot({ price: 90 });

    const first = detectListingEvents(previous, current, SYNCED_AT);
    const second = detectListingEvents(previous, current, SYNCED_AT);

    expect(first[0]?.dedupKey).toBe(second[0]?.dedupKey);
  });

  it("mesma mudança de preço detectada em sincronizações diferentes gera chaves diferentes", () => {
    const previous = snapshot({ price: 100 });
    const current = snapshot({ price: 90 });

    const first = detectListingEvents(previous, current, SYNCED_AT);
    const second = detectListingEvents(previous, current, new Date("2026-08-25T18:00:00.000Z"));

    expect(first[0]?.dedupKey).not.toBe(second[0]?.dedupKey);
  });
});
