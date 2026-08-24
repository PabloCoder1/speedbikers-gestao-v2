import { describe, expect, it } from "vitest";

import { diagnoseSalesAnomaly } from "./sales-anomaly.js";
import type { CorrelatedEvent, SalesBaselineSignal } from "./sales-anomaly.js";

const ORG_ID = "11111111-0000-4000-8000-000000000001";
const AS_OF = "2026-08-23";

function signal(overrides: Partial<SalesBaselineSignal> = {}): SalesBaselineSignal {
  return {
    skuId: "sku-1",
    sku: "SKU-1",
    title: "Produto de teste",
    weekday: 0,
    currentUnitsSold: 1,
    baselineMean: 1,
    baselineStddev: 1,
    sampleCount: 8,
    ...overrides,
  };
}

describe("diagnoseSalesAnomaly", () => {
  it("sinal dentro do baseline (|z| < 2): sem diagnóstico", () => {
    // current=2, mean=1, stddev=1 -> z=1, abaixo do limiar de 2.
    const result = diagnoseSalesAnomaly(ORG_ID, signal({ currentUnitsSold: 2 }), AS_OF, []);

    expect(result).toBeNull();
  });

  it("queda clara (z muito negativo): direção 'queda', confiança 'alta'", () => {
    // current=0, mean=3, stddev=0.5 -> z=-6.
    const result = diagnoseSalesAnomaly(
      ORG_ID,
      signal({ currentUnitsSold: 0, baselineMean: 3, baselineStddev: 0.5 }),
      AS_OF,
      [],
    );

    expect(result).not.toBeNull();
    expect(result?.direcao).toBe("queda");
    expect(result?.confianca).toBe("alta");
    expect(result?.zScore).toBeLessThan(-2);
  });

  it("alta clara (z muito positivo): direção 'alta' — mesmo sinal, mesmo peso de oportunidade", () => {
    // current=10, mean=2, stddev=1 -> z=8.
    const result = diagnoseSalesAnomaly(
      ORG_ID,
      signal({ currentUnitsSold: 10, baselineMean: 2, baselineStddev: 1 }),
      AS_OF,
      [],
    );

    expect(result).not.toBeNull();
    expect(result?.direcao).toBe("alta");
    expect(result?.confianca).toBe("alta");
  });

  it("anomalia moderada (2 <= |z| < 3): confiança 'media'", () => {
    // current=5, mean=3, stddev=1 -> z=2.
    const result = diagnoseSalesAnomaly(
      ORG_ID,
      signal({ currentUnitsSold: 5, baselineMean: 3, baselineStddev: 1 }),
      AS_OF,
      [],
    );

    expect(result).not.toBeNull();
    expect(result?.confianca).toBe("media");
  });

  it("amostra insuficiente (sampleCount < 4): sem diagnóstico, mesmo com desvio grande", () => {
    const result = diagnoseSalesAnomaly(
      ORG_ID,
      signal({ currentUnitsSold: 0, baselineMean: 3, baselineStddev: 0.5, sampleCount: 3 }),
      AS_OF,
      [],
    );

    expect(result).toBeNull();
  });

  it("baseline_mean <= 0: sem diagnóstico (nenhuma base real para comparar)", () => {
    const result = diagnoseSalesAnomaly(ORG_ID, signal({ baselineMean: 0, baselineStddev: 0 }), AS_OF, []);

    expect(result).toBeNull();
  });

  it("baseline_stddev <= 0: sem diagnóstico (z-score indefinido)", () => {
    const result = diagnoseSalesAnomaly(
      ORG_ID,
      signal({ currentUnitsSold: 5, baselineMean: 1, baselineStddev: 0 }),
      AS_OF,
      [],
    );

    expect(result).toBeNull();
  });

  it("sem evento correlato: próximos passos aponta investigação manual, causas_candidatas vazio", () => {
    const result = diagnoseSalesAnomaly(
      ORG_ID,
      signal({ currentUnitsSold: 0, baselineMean: 3, baselineStddev: 0.5 }),
      AS_OF,
      [],
    );

    expect(result?.causasCandidatas).toEqual([]);
    expect(result?.proximosPassos[0]).toContain("Nenhum evento correlato");
  });

  it("com evento correlato (stock.depleted): vira causa candidata com descrição própria", () => {
    const events: CorrelatedEvent[] = [
      { eventType: "stock.depleted", occurredAt: new Date("2026-08-22T21:00:00.000Z") },
    ];

    const result = diagnoseSalesAnomaly(
      ORG_ID,
      signal({ currentUnitsSold: 0, baselineMean: 3, baselineStddev: 0.5 }),
      AS_OF,
      events,
    );

    expect(result?.causasCandidatas).toHaveLength(1);
    expect(result?.causasCandidatas[0]?.eventType).toBe("stock.depleted");
    expect(result?.causasCandidatas[0]?.descricao).toContain("Estoque zerou");
    expect(result?.proximosPassos[0]).toContain("evento correlato");
  });

  it("escopo e período carregam organizationId/skuId/asOf recebidos", () => {
    const result = diagnoseSalesAnomaly(
      ORG_ID,
      signal({ skuId: "sku-42", currentUnitsSold: 0, baselineMean: 3, baselineStddev: 0.5 }),
      AS_OF,
      [],
    );

    expect(result?.escopo).toEqual({ organizationId: ORG_ID, skuId: "sku-42" });
    expect(result?.periodo).toEqual({ asOf: AS_OF });
  });

  it("evidências citam o SKU, o valor vendido e o baseline com desvio", () => {
    const result = diagnoseSalesAnomaly(
      ORG_ID,
      signal({ sku: "SKU-XYZ", currentUnitsSold: 0, baselineMean: 3, baselineStddev: 0.5, sampleCount: 6 }),
      AS_OF,
      [],
    );

    expect(result?.evidencias).toHaveLength(1);
    expect(result?.evidencias[0]?.descricao).toContain("SKU-XYZ");
    expect(result?.evidencias[0]?.descricao).toContain("0 unidade");
    expect(result?.evidencias[0]?.descricao).toContain("3.0");
  });
});
