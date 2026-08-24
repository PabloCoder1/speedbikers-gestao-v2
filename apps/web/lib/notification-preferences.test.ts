import { describe, expect, it } from "vitest";

import { shouldNotify, type NotificationPreferenceRule } from "./notification-preferences";

const CONTA_A = "conta-a";
const CONTA_B = "conta-b";

describe("shouldNotify", () => {
  it("sem nenhuma regra aplicável, notifica por padrão", () => {
    expect(shouldNotify([], { eventType: "listing.price.changed", mlAccountId: CONTA_A, severity: "informativo" })).toBe(
      true,
    );
  });

  it("enabled=false suprime o toast pro event_type desativado", () => {
    const rules: NotificationPreferenceRule[] = [
      { eventType: "listing.price.changed", mlAccountId: null, minSeverity: "informativo", enabled: false },
    ];

    expect(shouldNotify(rules, { eventType: "listing.price.changed", mlAccountId: CONTA_A, severity: "critico" })).toBe(
      false,
    );
  });

  it("severidade abaixo do mínimo pedido suprime o toast", () => {
    const rules: NotificationPreferenceRule[] = [
      { eventType: "listing.title.changed", mlAccountId: CONTA_A, minSeverity: "importante", enabled: true },
    ];

    expect(
      shouldNotify(rules, { eventType: "listing.title.changed", mlAccountId: CONTA_A, severity: "informativo" }),
    ).toBe(false);
  });

  it("severidade igual ou acima do mínimo pedido notifica", () => {
    const rules: NotificationPreferenceRule[] = [
      { eventType: "listing.title.changed", mlAccountId: CONTA_A, minSeverity: "importante", enabled: true },
    ];

    expect(
      shouldNotify(rules, { eventType: "listing.title.changed", mlAccountId: CONTA_A, severity: "critico" }),
    ).toBe(true);
  });

  it("regra mais específica (event_type + conta) vence sobre curinga geral", () => {
    const rules: NotificationPreferenceRule[] = [
      { eventType: null, mlAccountId: null, minSeverity: "informativo", enabled: false },
      { eventType: "listing.price.changed", mlAccountId: CONTA_A, minSeverity: "informativo", enabled: true },
    ];

    expect(shouldNotify(rules, { eventType: "listing.price.changed", mlAccountId: CONTA_A, severity: "informativo" })).toBe(
      true,
    );
  });

  it("regra de outra conta não se aplica — curinga geral (sem conta) decide", () => {
    const rules: NotificationPreferenceRule[] = [
      { eventType: null, mlAccountId: null, minSeverity: "informativo", enabled: false },
      { eventType: "listing.price.changed", mlAccountId: CONTA_A, minSeverity: "informativo", enabled: true },
    ];

    expect(shouldNotify(rules, { eventType: "listing.price.changed", mlAccountId: CONTA_B, severity: "informativo" })).toBe(
      false,
    );
  });

  it("regra curinga de conta (sem event_type) se aplica a qualquer tipo de evento daquela conta", () => {
    const rules: NotificationPreferenceRule[] = [
      { eventType: null, mlAccountId: CONTA_A, minSeverity: "critico", enabled: true },
    ];

    expect(
      shouldNotify(rules, { eventType: "listing.available_quantity.changed", mlAccountId: CONTA_A, severity: "informativo" }),
    ).toBe(false);
    expect(shouldNotify(rules, { eventType: "stock.depleted", mlAccountId: CONTA_A, severity: "critico" })).toBe(true);
  });
});
