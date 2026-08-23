import { describe, expect, it } from "vitest";

import { availablePurchaseOrderActions, isTerminalPurchaseOrderStatus } from "./state-machine.js";

describe("availablePurchaseOrderActions", () => {
  it("DRAFT: pode editar, aprovar ou cancelar", () => {
    expect(availablePurchaseOrderActions("DRAFT")).toEqual(["UPDATE", "APPROVE", "CANCEL"]);
  });

  it("APPROVED: pode marcar como pedido ou cancelar, não pode mais editar", () => {
    expect(availablePurchaseOrderActions("APPROVED")).toEqual(["MARK_ORDERED", "CANCEL"]);
  });

  it("ORDERED: pode receber ou cancelar", () => {
    expect(availablePurchaseOrderActions("ORDERED")).toEqual(["RECEIVE", "CANCEL"]);
  });

  it("RECEIVED: estado terminal, nenhuma ação disponível", () => {
    expect(availablePurchaseOrderActions("RECEIVED")).toEqual([]);
  });

  it("CANCELLED: estado terminal, nenhuma ação disponível", () => {
    expect(availablePurchaseOrderActions("CANCELLED")).toEqual([]);
  });
});

describe("isTerminalPurchaseOrderStatus", () => {
  it.each(["DRAFT", "APPROVED", "ORDERED"] as const)("%s não é terminal", (status) => {
    expect(isTerminalPurchaseOrderStatus(status)).toBe(false);
  });

  it.each(["RECEIVED", "CANCELLED"] as const)("%s é terminal", (status) => {
    expect(isTerminalPurchaseOrderStatus(status)).toBe(true);
  });
});
