import { describe, expect, it } from "vitest";

import { resolveNotifyEpoch } from "./sync-support-claims-reconcile.js";

describe("resolveNotifyEpoch (D-110)", () => {
  it("conta antiga usa a época global — o estoque pré-deploy fica mudo", () => {
    expect(resolveNotifyEpoch("2026-08-21T10:00:00.000Z")).toBe("2026-08-27T21:00:00.000Z");
  });

  it("conta conectada DEPOIS do deploy usa a própria conexão como piso", () => {
    // O cenário da conta nova conectada meses depois: sem o piso, a primeira
    // varredura despejaria os 7 dias de backlog pré-conexão como notificação
    // — a segunda falha bloqueante do desenho original.
    expect(resolveNotifyEpoch("2026-12-01T15:30:00.000Z")).toBe("2026-12-01T15:30:00.000Z");
  });

  it("sem connected_at, a época global vale sozinha", () => {
    expect(resolveNotifyEpoch(null)).toBe("2026-08-27T21:00:00.000Z");
  });

  it("compara instantes, não strings — offset não engana o piso", () => {
    // 19:00-03:00 = 22:00Z, uma hora DEPOIS da época global de 21:00Z.
    expect(resolveNotifyEpoch("2026-08-27T19:00:00.000-03:00")).toBe("2026-08-27T22:00:00.000Z");
  });
});
