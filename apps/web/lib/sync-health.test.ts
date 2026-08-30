import { describe, expect, it } from "vitest";

import { classifyResourceFreshness, failureRateLabel } from "./sync-health";

const NOW = new Date("2026-08-30T12:00:00Z");

function minutesAgo(min: number): string {
  return new Date(NOW.getTime() - min * 60_000).toISOString();
}

describe("classifyResourceFreshness", () => {
  it("orders (cadência horária): ok até 2h, atenção até 4h, crítico depois", () => {
    expect(classifyResourceFreshness("orders", "reconciliation", minutesAgo(30), NOW)).toBe("ok");
    expect(classifyResourceFreshness("orders", "reconciliation", minutesAgo(119), NOW)).toBe("ok");
    expect(classifyResourceFreshness("orders", "reconciliation", minutesAgo(180), NOW)).toBe("atencao");
    expect(classifyResourceFreshness("orders", "reconciliation", minutesAgo(300), NOW)).toBe("critico");
  });

  /**
   * O caso que derrubou a ideia de reusar a fórmula de pedidos: visits roda
   * UMA vez por dia. Com os limiares de orders, 20 horas desde o último
   * sucesso seria "crítico" — para uma sincronização funcionando exatamente
   * como projetada.
   */
  it("visits (cadência diária): 20h atrás é OK, não crítico", () => {
    expect(classifyResourceFreshness("visits", "reconciliation", minutesAgo(20 * 60), NOW)).toBe("ok");
    expect(classifyResourceFreshness("visits", "reconciliation", minutesAgo(3 * 1440), NOW)).toBe("atencao");
    expect(classifyResourceFreshness("visits", "reconciliation", minutesAgo(5 * 1440), NOW)).toBe("critico");
  });

  it("messages (10 min): degrada rápido, como deve", () => {
    expect(classifyResourceFreshness("messages", "reconciliation", minutesAgo(15), NOW)).toBe("ok");
    expect(classifyResourceFreshness("messages", "reconciliation", minutesAgo(35), NOW)).toBe("atencao");
    expect(classifyResourceFreshness("messages", "reconciliation", minutesAgo(60), NOW)).toBe("critico");
  });

  /**
   * Backfill é finito: "não rodou nas últimas 24h" é o estado NORMAL de um
   * backfill concluído. Carimbar frescor nele faria a tela gritar sobre o
   * comportamento certo — o defeito que o filtro `channel=reconciliation` da
   * tela antiga já existia para evitar (achado de produção de 2026-08-22).
   */
  it("backfill nunca ganha veredito de frescor", () => {
    expect(classifyResourceFreshness("orders", "backfill", minutesAgo(10_000), NOW)).toBe("sem_cadencia");
  });

  it("recurso sem cadência mapeada não ganha veredito chutado", () => {
    expect(classifyResourceFreshness("recurso_novo", "reconciliation", minutesAgo(5), NOW)).toBe("sem_cadencia");
  });

  it("sem sucesso nenhum é 'nunca', não crítico", () => {
    expect(classifyResourceFreshness("orders", "reconciliation", null, NOW)).toBe("nunca");
  });
});

describe("failureRateLabel", () => {
  /** O caso real medido em 2026-08-30: visits com 85% de falha por 429. */
  it("nomeia a taxa quando há falha", () => {
    expect(failureRateLabel(20, 17)).toBe("17 de 20 execuções falharam (85%)");
  });

  it("zero falha ou zero execução não produz alerta", () => {
    expect(failureRateLabel(24, 0)).toBeNull();
    expect(failureRateLabel(0, 0)).toBeNull();
  });
});
