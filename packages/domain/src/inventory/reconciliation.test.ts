import { describe, expect, it } from "vitest";

import { computeReconciliationAdjustments } from "./reconciliation.js";
import type { ReconciliationBalance } from "./reconciliation.js";

const OCCURRED_AT = new Date("2026-08-23T06:00:00.000Z");
const BUSINESS_DATE = "2026-08-23";

describe("computeReconciliationAdjustments", () => {
  it("ledger abaixo do snapshot: ajuste positivo traz o ledger para cima", () => {
    const snapshot: ReconciliationBalance[] = [{ skuId: "sku-a", locationKind: "LOCAL", quantity: 50 }];
    const ledger: ReconciliationBalance[] = [{ skuId: "sku-a", locationKind: "LOCAL", quantity: 42 }];

    const result = computeReconciliationAdjustments(snapshot, ledger, BUSINESS_DATE, OCCURRED_AT);

    expect(result).toHaveLength(1);
    expect(result[0]?.movement).toEqual({
      skuId: "sku-a",
      qtyDelta: 8,
      idempotencyKey: `reconciliacao:${BUSINESS_DATE}:sku-a:LOCAL`,
      occurredAt: OCCURRED_AT,
      locationKind: "LOCAL",
    });
  });

  it("ledger acima do snapshot: ajuste negativo traz o ledger para baixo", () => {
    const snapshot: ReconciliationBalance[] = [{ skuId: "sku-a", locationKind: "LOCAL", quantity: 10 }];
    const ledger: ReconciliationBalance[] = [{ skuId: "sku-a", locationKind: "LOCAL", quantity: 15 }];

    const result = computeReconciliationAdjustments(snapshot, ledger, BUSINESS_DATE, OCCURRED_AT);

    expect(result[0]?.movement.qtyDelta).toBe(-5);
  });

  it("sem divergência não gera ajuste nenhum", () => {
    const snapshot: ReconciliationBalance[] = [{ skuId: "sku-a", locationKind: "LOCAL", quantity: 20 }];
    const ledger: ReconciliationBalance[] = [{ skuId: "sku-a", locationKind: "LOCAL", quantity: 20 }];

    expect(computeReconciliationAdjustments(snapshot, ledger, BUSINESS_DATE, OCCURRED_AT)).toEqual([]);
  });

  it("SKU sem linha no ledger: trata como zero — é assim que RESERVADO nasce pela primeira vez", () => {
    const snapshot: ReconciliationBalance[] = [{ skuId: "sku-novo", locationKind: "RESERVADO", quantity: 6 }];

    const result = computeReconciliationAdjustments(snapshot, [], BUSINESS_DATE, OCCURRED_AT);

    expect(result[0]?.movement).toMatchObject({ skuId: "sku-novo", qtyDelta: 6, locationKind: "RESERVADO" });
  });

  it("SKU no ledger sem linha correspondente no snapshot não é tocado — sem opinião do UpSeller sobre ele", () => {
    const ledger: ReconciliationBalance[] = [{ skuId: "sku-so-v3", locationKind: "LOCAL", quantity: 100 }];

    expect(computeReconciliationAdjustments([], ledger, BUSINESS_DATE, OCCURRED_AT)).toEqual([]);
  });

  it("LOCAL e RESERVADO do mesmo SKU são comparados independentemente", () => {
    const snapshot: ReconciliationBalance[] = [
      { skuId: "sku-a", locationKind: "LOCAL", quantity: 30 },
      { skuId: "sku-a", locationKind: "RESERVADO", quantity: 5 },
    ];
    const ledger: ReconciliationBalance[] = [{ skuId: "sku-a", locationKind: "LOCAL", quantity: 30 }];

    const result = computeReconciliationAdjustments(snapshot, ledger, BUSINESS_DATE, OCCURRED_AT);

    expect(result).toHaveLength(1);
    expect(result[0]?.movement).toMatchObject({ locationKind: "RESERVADO", qtyDelta: 5 });
  });

  it("evento stock.balance.adjusted: INFORMATIVO, source system, before/after com a quantidade certa", () => {
    const snapshot: ReconciliationBalance[] = [{ skuId: "sku-a", locationKind: "LOCAL", quantity: 50 }];
    const ledger: ReconciliationBalance[] = [{ skuId: "sku-a", locationKind: "LOCAL", quantity: 42 }];

    const result = computeReconciliationAdjustments(snapshot, ledger, BUSINESS_DATE, OCCURRED_AT);

    expect(result[0]?.event).toEqual({
      eventType: "stock.balance.adjusted",
      entityType: "sku",
      entityId: "sku-a",
      before: { locationKind: "LOCAL", quantity: 42 },
      after: { locationKind: "LOCAL", quantity: 50 },
      severity: "informativo",
      source: "system",
      dedupKey: `reconciliacao:${BUSINESS_DATE}:sku-a:LOCAL`,
      occurredAt: OCCURRED_AT,
    });
  });

  /**
   * A trava de D-135. Os dois caminhos de estoque nasceram com o MESMO
   * `event_type` e a mesma severidade, e foi isso que fez 657–896 alertas
   * críticos por dia sobre rotina já corrigida. Reunificá-los por descuido
   * — um `EVENT_SEVERITY` copiado, um find-and-replace — devolveria o
   * problema em silêncio, porque nada quebra: o evento continua gravando.
   * Este teste falha no instante em que a reconciliação voltar a emitir
   * `diverged` ou a subir de `informativo`.
   */
  it("a reconciliação NUNCA emite `stock.balance.diverged` — esse tipo é do vigia de integridade (D-135)", () => {
    const snapshot: ReconciliationBalance[] = [
      { skuId: "sku-a", locationKind: "LOCAL", quantity: 50 },
      { skuId: "sku-b", locationKind: "RESERVADO", quantity: 7 },
    ];
    const ledger: ReconciliationBalance[] = [{ skuId: "sku-a", locationKind: "LOCAL", quantity: 42 }];

    const result = computeReconciliationAdjustments(snapshot, ledger, BUSINESS_DATE, OCCURRED_AT);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.event.eventType)).toEqual(["stock.balance.adjusted", "stock.balance.adjusted"]);
    expect(result.map((r) => r.event.severity)).toEqual(["informativo", "informativo"]);
  });

  it("movimento e evento compartilham a MESMA chave — um ajuste, uma explicação, sem risco de divergir entre si", () => {
    const snapshot: ReconciliationBalance[] = [{ skuId: "sku-a", locationKind: "LOCAL", quantity: 50 }];

    const result = computeReconciliationAdjustments(snapshot, [], BUSINESS_DATE, OCCURRED_AT);

    expect(result[0]?.movement.idempotencyKey).toBe(result[0]?.event.dedupKey);
  });

  it("chave de idempotência inclui a data de negócio — rodadas de dias diferentes não colidem", () => {
    const snapshot: ReconciliationBalance[] = [{ skuId: "sku-a", locationKind: "LOCAL", quantity: 50 }];

    const day1 = computeReconciliationAdjustments(snapshot, [], "2026-08-23", OCCURRED_AT);
    const day2 = computeReconciliationAdjustments(snapshot, [], "2026-08-24", OCCURRED_AT);

    expect(day1[0]?.movement.idempotencyKey).not.toBe(day2[0]?.movement.idempotencyKey);
  });
});
