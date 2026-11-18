import { describe, expect, it } from "vitest";

import { shouldNotify, type NotificationPreferenceRule } from "./notification-preferences";

const CONTA_A = "conta-a";
const CONTA_B = "conta-b";
const LOJA_A = "loja-a";
const LOJA_B = "loja-b";

describe("shouldNotify", () => {
  it("sem nenhuma regra aplicável, notifica por padrão", () => {
    expect(shouldNotify([], { eventType: "listing.price.changed", mlAccountId: CONTA_A, shopeeShopId: null, severity: "informativo" })).toBe(
      true,
    );
  });

  it("enabled=false suprime o toast pro event_type desativado", () => {
    const rules: NotificationPreferenceRule[] = [
      { eventType: "listing.price.changed", mlAccountId: null, shopeeShopId: null, minSeverity: "informativo", enabled: false },
    ];

    expect(shouldNotify(rules, { eventType: "listing.price.changed", mlAccountId: CONTA_A, shopeeShopId: null, severity: "critico" })).toBe(
      false,
    );
  });

  it("severidade abaixo do mínimo pedido suprime o toast", () => {
    const rules: NotificationPreferenceRule[] = [
      { eventType: "listing.title.changed", mlAccountId: CONTA_A, shopeeShopId: null, minSeverity: "importante", enabled: true },
    ];

    expect(
      shouldNotify(rules, { eventType: "listing.title.changed", mlAccountId: CONTA_A, shopeeShopId: null, severity: "informativo" }),
    ).toBe(false);
  });

  it("severidade igual ou acima do mínimo pedido notifica", () => {
    const rules: NotificationPreferenceRule[] = [
      { eventType: "listing.title.changed", mlAccountId: CONTA_A, shopeeShopId: null, minSeverity: "importante", enabled: true },
    ];

    expect(
      shouldNotify(rules, { eventType: "listing.title.changed", mlAccountId: CONTA_A, shopeeShopId: null, severity: "critico" }),
    ).toBe(true);
  });

  it("regra mais específica (event_type + conta) vence sobre curinga geral", () => {
    const rules: NotificationPreferenceRule[] = [
      { eventType: null, mlAccountId: null, shopeeShopId: null, minSeverity: "informativo", enabled: false },
      { eventType: "listing.price.changed", mlAccountId: CONTA_A, shopeeShopId: null, minSeverity: "informativo", enabled: true },
    ];

    expect(shouldNotify(rules, { eventType: "listing.price.changed", mlAccountId: CONTA_A, shopeeShopId: null, severity: "informativo" })).toBe(
      true,
    );
  });

  it("regra de outra conta não se aplica — curinga geral (sem conta) decide", () => {
    const rules: NotificationPreferenceRule[] = [
      { eventType: null, mlAccountId: null, shopeeShopId: null, minSeverity: "informativo", enabled: false },
      { eventType: "listing.price.changed", mlAccountId: CONTA_A, shopeeShopId: null, minSeverity: "informativo", enabled: true },
    ];

    expect(shouldNotify(rules, { eventType: "listing.price.changed", mlAccountId: CONTA_B, shopeeShopId: null, severity: "informativo" })).toBe(
      false,
    );
  });

  it("regra curinga de conta (sem event_type) se aplica a qualquer tipo de evento daquela conta", () => {
    const rules: NotificationPreferenceRule[] = [
      { eventType: null, mlAccountId: CONTA_A, shopeeShopId: null, minSeverity: "critico", enabled: true },
    ];

    expect(
      shouldNotify(rules, { eventType: "listing.available_quantity.changed", mlAccountId: CONTA_A, shopeeShopId: null, severity: "informativo" }),
    ).toBe(false);
    expect(shouldNotify(rules, { eventType: "stock.depleted", mlAccountId: CONTA_A, shopeeShopId: null, severity: "critico" })).toBe(true);
  });

  it("uma regra desativada de loja só silencia os eventos daquela loja", () => {
    const rules = [
      { eventType: null, mlAccountId: null, shopeeShopId: LOJA_A, minSeverity: "informativo", enabled: false },
    ];
    const eventoLoja = {
      eventType: "listing.price.changed",
      mlAccountId: null,
      shopeeShopId: LOJA_A,
      severity: "importante",
    };
    const outraLoja = { ...eventoLoja, shopeeShopId: LOJA_B };
    const eventoMl = { ...eventoLoja, mlAccountId: CONTA_A, shopeeShopId: null };
    const eventoOrg = { ...eventoLoja, shopeeShopId: null };

    expect(shouldNotify(rules, eventoLoja)).toBe(false);
    expect(shouldNotify(rules, outraLoja)).toBe(true);
    expect(shouldNotify(rules, eventoMl)).toBe(true);
    expect(shouldNotify(rules, eventoOrg)).toBe(true);
  });

  it("regras de tipo e origem vencem a regra de tipo geral no mesmo evento", () => {
    const tipo = "listing.price.changed";
    const rules = [
      { eventType: tipo, mlAccountId: null, shopeeShopId: null, minSeverity: "informativo", enabled: true },
      { eventType: tipo, mlAccountId: null, shopeeShopId: LOJA_A, minSeverity: "critico", enabled: true },
      { eventType: tipo, mlAccountId: CONTA_A, shopeeShopId: null, minSeverity: "informativo", enabled: false },
    ];
    const eventoLoja = { eventType: tipo, mlAccountId: null, shopeeShopId: LOJA_A, severity: "importante" };
    const outraLoja = { ...eventoLoja, shopeeShopId: LOJA_B };
    const eventoMl = { ...eventoLoja, mlAccountId: CONTA_A, shopeeShopId: null };
    const eventoOrg = { ...eventoLoja, shopeeShopId: null };

    expect(shouldNotify(rules, eventoLoja)).toBe(false);
    const eventoCritico = { ...eventoLoja, severity: "critico" };
    expect(shouldNotify(rules, eventoCritico)).toBe(true);
    expect(shouldNotify(rules, outraLoja)).toBe(true);
    expect(shouldNotify(rules, eventoMl)).toBe(false);
    expect(shouldNotify(rules, eventoOrg)).toBe(true);
  });
});
