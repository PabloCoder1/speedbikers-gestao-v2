import { describe, expect, it } from "vitest";

import { podeOperarCompras } from "./purchase-order-permission";

describe("podeOperarCompras", () => {
  it("segue check_purchase_order_writer: só ADMIN e GESTOR", () => {
    expect(podeOperarCompras("ADMIN")).toBe(true);
    expect(podeOperarCompras("GESTOR")).toBe(true);
    expect(podeOperarCompras("OPERADOR")).toBe(false);
    expect(podeOperarCompras("ANALISTA")).toBe(false);
    expect(podeOperarCompras(null)).toBe(false);
  });
});
