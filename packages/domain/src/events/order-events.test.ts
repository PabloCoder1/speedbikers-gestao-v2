import { describe, expect, it } from "vitest";

import { detectOrderStatusEvents } from "./order-events.js";

const OCCURRED_AT = new Date("2026-08-21T15:00:00.000Z");

describe("detectOrderStatusEvents", () => {
  it("nenhum evento quando o status não é de cancelamento", () => {
    const events = detectOrderStatusEvents("payment_in_process", { id: 1, status: "paid" }, OCCURRED_AT);

    expect(events).toEqual([]);
  });

  it("emite order.cancelled na transição para cancelled", () => {
    const events = detectOrderStatusEvents("paid", { id: 2_032_217_210, status: "cancelled" }, OCCURRED_AT);

    expect(events).toEqual([
      {
        eventType: "order.cancelled",
        entityType: "order",
        entityId: "2032217210",
        before: { status: "paid" },
        after: { status: "cancelled" },
        severity: "importante",
        source: "sync",
        dedupKey: "order.cancelled:2032217210:cancelled",
        occurredAt: OCCURRED_AT,
      },
    ]);
  });

  it("emite order.cancelled na transição para pending_cancel — já é a notícia que importa", () => {
    const events = detectOrderStatusEvents("paid", { id: 1, status: "pending_cancel" }, OCCURRED_AT);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ after: { status: "pending_cancel" } });
  });

  it("não reemite quando o pedido já estava cancelled", () => {
    const events = detectOrderStatusEvents("cancelled", { id: 1, status: "cancelled" }, OCCURRED_AT);

    expect(events).toEqual([]);
  });

  it("não reemite na progressão pending_cancel -> cancelled — mesma notícia, já contada", () => {
    const events = detectOrderStatusEvents("pending_cancel", { id: 1, status: "cancelled" }, OCCURRED_AT);

    expect(events).toEqual([]);
  });

  it("emite quando a order chega pela primeira vez já cancelada (ex.: backfill de história antiga)", () => {
    const events = detectOrderStatusEvents(null, { id: 1, status: "cancelled" }, OCCURRED_AT);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ before: { status: null } });
  });

  it("entityId é sempre string, nunca o number bruto do id do Mercado Livre", () => {
    const events = detectOrderStatusEvents("paid", { id: 999, status: "cancelled" }, OCCURRED_AT);

    expect(events[0]?.entityId).toBe("999");
    expect(typeof events[0]?.entityId).toBe("string");
  });
});
