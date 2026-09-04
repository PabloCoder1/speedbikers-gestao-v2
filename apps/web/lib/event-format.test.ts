import { describe, expect, it } from "vitest";

import { formatCurrency } from "./format";
import { entityHref, entityLabel, formatEventDiff, scalar } from "./event-format";

describe("formatEventDiff", () => {
  it("listing.price.changed formata os dois lados como moeda", () => {
    // `formatCurrency` (não um literal de string) monta o esperado: o
    // Intl.NumberFormat do Node usa espaço não separável (U+00A0) entre
    // "R$" e o valor — um literal digitado à mão usaria espaço normal e
    // falharia por um caractere invisível diferente.
    expect(formatEventDiff("listing.price.changed", { price: 399.9 }, { price: 379.9 })).toBe(
      `${formatCurrency(399.9)} → ${formatCurrency(379.9)}`,
    );
  });

  it("listing.title.changed cerca os dois lados em aspas", () => {
    expect(formatEventDiff("listing.title.changed", { title: "Capacete X" }, { title: "Capacete Y" })).toBe(
      '"Capacete X" → "Capacete Y"',
    );
  });

  it("listing.available_quantity.changed mostra os números brutos", () => {
    expect(formatEventDiff("listing.available_quantity.changed", { availableQuantity: 10 }, { availableQuantity: 0 })).toBe(
      "10 → 0",
    );
  });

  it("listing.status.paused traduz os dois lados pelo rótulo de status", () => {
    expect(formatEventDiff("listing.status.paused", { status: "active" }, { status: "paused" })).toBe(
      "Ativo → Pausado",
    );
  });

  it("listing.status.reactivated também traduz pelo rótulo de status", () => {
    expect(formatEventDiff("listing.status.reactivated", { status: "paused" }, { status: "active" })).toBe(
      "Pausado → Ativo",
    );
  });

  it("before/after nulo não quebra — cai no traço padrão dos dois lados", () => {
    expect(formatEventDiff("listing.price.changed", null, null)).toBe(`${formatCurrency(null)} → ${formatCurrency(null)}`);
  });

  it("tipo de evento sem formato documentado retorna null, não inventa leitura", () => {
    expect(formatEventDiff("order.cancelled", { status: "confirmed" }, { status: "cancelled" })).toBeNull();
    expect(formatEventDiff("stock.depleted", { quantity: 5 }, { quantity: 0 })).toBeNull();
  });
});

describe("scalar", () => {
  it("string e number passam direto", () => {
    expect(scalar("ativo")).toBe("ativo");
    expect(scalar(42)).toBe("42");
  });

  it("objeto, array, null e undefined viram o traço padrão, nunca '[object Object]'", () => {
    expect(scalar({ a: 1 })).toBe("—");
    expect(scalar([1, 2])).toBe("—");
    expect(scalar(null)).toBe("—");
    expect(scalar(undefined)).toBe("—");
  });
});

describe("entityHref", () => {
  it("sku vira link pro Dashboard de SKU", () => {
    expect(entityHref("sku", "abc-123")).toBe("/skus/abc-123");
  });

  /**
   * `entity_id` de um evento de anúncio é o `item_id` (o MLB), que é o
   * parâmetro da rota `/anuncios/[itemId]` — a mesma chave que o Dashboard do
   * Anúncio usa para se achar. A rota existe desde D-168; o link só entrou em
   * D13, quando a migração da tela releu o registro envelhecido que dizia
   * "anúncio ainda não tem tela própria".
   */
  it("listing vira link pro Dashboard do Anúncio, pelo MLB", () => {
    expect(entityHref("listing", "MLB123")).toBe("/anuncios/MLB123");
  });

  /**
   * A guarda que impede o link quebrado: `listing.fulfillment.entered` grava o
   * `inventoryId` em `entity_id` com `entity_type = "listing"`, e inventory e
   * item são identificadores diferentes (`fulfillment_stock_snapshots` guarda
   * os dois em colunas separadas). Sem conferir o formato, essa notificação
   * apontaria para uma página que não existe.
   */
  it("listing cujo entity_id NÃO é um MLB não vira link — é o inventory_id do evento de Full", () => {
    expect(entityHref("listing", "INV-88231")).toBeNull();
    expect(entityHref("listing", "88231")).toBeNull();
  });

  it("order continua sem tela própria — sem link", () => {
    expect(entityHref("order", "999")).toBeNull();
  });
});

describe("entityLabel", () => {
  it("traduz os três tipos conhecidos e cai no código bruto pros demais", () => {
    expect(entityLabel("sku")).toBe("SKU");
    expect(entityLabel("listing")).toBe("Anúncio");
    expect(entityLabel("order")).toBe("Pedido");
    expect(entityLabel("inventory")).toBe("inventory");
  });
});
