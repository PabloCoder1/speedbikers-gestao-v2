import { describe, expect, it } from "vitest";

import { evaluateAiBudget } from "./ai-budget.js";

const OCCURRED_AT = new Date("2026-08-27T12:00:00.000Z");

const BASE = {
  organizationId: "org-1",
  month: "2026-08",
  budgetUsd: 18,
};

describe("evaluateAiBudget", () => {
  it("dentro do teto: nenhum evento", () => {
    expect(evaluateAiBudget({ ...BASE, monthCostUsd: 5.42 }, OCCURRED_AT)).toBeNull();
  });

  it("exatamente no teto ainda está dentro do combinado — nenhum evento", () => {
    expect(evaluateAiBudget({ ...BASE, monthCostUsd: 18 }, OCCURRED_AT)).toBeNull();
  });

  it("custo zero (mês sem chamada de LLM): nenhum evento", () => {
    expect(evaluateAiBudget({ ...BASE, monthCostUsd: 0 }, OCCURRED_AT)).toBeNull();
  });

  it("acima do teto: evento com premissas visíveis e severidade do catálogo", () => {
    const draft = evaluateAiBudget({ ...BASE, monthCostUsd: 18.01 }, OCCURRED_AT);

    expect(draft).toEqual({
      eventType: "ai.budget.exceeded",
      entityType: "organization",
      entityId: "org-1",
      before: { month: "2026-08", budgetUsd: 18 },
      after: { month: "2026-08", budgetUsd: 18, monthCostUsd: 18.01 },
      severity: "importante",
      source: "system",
      dedupKey: "ai-budget:org-1:2026-08",
      occurredAt: OCCURRED_AT,
    });
  });

  it("dedupKey embute organização e mês — um aviso por organização por mês, e o mês seguinte reabre sozinho", () => {
    const agosto = evaluateAiBudget({ ...BASE, monthCostUsd: 20 }, OCCURRED_AT);
    const setembro = evaluateAiBudget({ ...BASE, month: "2026-09", monthCostUsd: 20 }, OCCURRED_AT);
    const outraOrg = evaluateAiBudget(
      { ...BASE, organizationId: "org-2", monthCostUsd: 20 },
      OCCURRED_AT,
    );

    expect(agosto?.dedupKey).toBe("ai-budget:org-1:2026-08");
    expect(setembro?.dedupKey).toBe("ai-budget:org-1:2026-09");
    expect(outraOrg?.dedupKey).toBe("ai-budget:org-2:2026-08");
  });

  it("teto inválido (zero, negativo ou não finito) lança — configuração errada não pode virar silêncio", () => {
    expect(() => evaluateAiBudget({ ...BASE, budgetUsd: 0, monthCostUsd: 1 }, OCCURRED_AT)).toThrow(RangeError);
    expect(() => evaluateAiBudget({ ...BASE, budgetUsd: -5, monthCostUsd: 1 }, OCCURRED_AT)).toThrow(RangeError);
    expect(() => evaluateAiBudget({ ...BASE, budgetUsd: Number.NaN, monthCostUsd: 1 }, OCCURRED_AT)).toThrow(
      RangeError,
    );
  });

  it("custo negativo lança — soma de custo nunca é negativa, isso seria bug de leitura", () => {
    expect(() => evaluateAiBudget({ ...BASE, monthCostUsd: -0.01 }, OCCURRED_AT)).toThrow(RangeError);
  });
});
