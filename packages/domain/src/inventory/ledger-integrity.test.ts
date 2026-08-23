import { describe, expect, it } from "vitest";

import { computeLedgerIntegrityDivergences } from "./ledger-integrity.js";
import type { LedgerBalance } from "./ledger-integrity.js";

const OCCURRED_AT = new Date("2026-08-23T09:00:00.000Z");
const BUSINESS_DATE = "2026-08-23";

describe("computeLedgerIntegrityDivergences", () => {
  it("ledger e projeção batendo não gera nenhum evento", () => {
    const ledger: LedgerBalance[] = [{ skuId: "sku-1", locationKind: "LOCAL", quantity: 10 }];
    const projected: LedgerBalance[] = [{ skuId: "sku-1", locationKind: "LOCAL", quantity: 10 }];

    expect(computeLedgerIntegrityDivergences(ledger, projected, BUSINESS_DATE, OCCURRED_AT)).toEqual([]);
  });

  it("projeção atrasada em relação ao ledger gera evento crítico", () => {
    const ledger: LedgerBalance[] = [{ skuId: "sku-1", locationKind: "LOCAL", quantity: 15 }];
    const projected: LedgerBalance[] = [{ skuId: "sku-1", locationKind: "LOCAL", quantity: 10 }];

    const events = computeLedgerIntegrityDivergences(ledger, projected, BUSINESS_DATE, OCCURRED_AT);

    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("stock.balance.diverged");
    expect(events[0]?.severity).toBe("critico");
    expect(events[0]?.before).toEqual({ locationKind: "LOCAL", quantity: 10, checkedAgainst: "ledger_vs_projection" });
    expect(events[0]?.after).toEqual({ locationKind: "LOCAL", quantity: 15, checkedAgainst: "ledger_vs_projection" });
  });

  it("linha ausente na projeção conta como zero — também é divergência", () => {
    const ledger: LedgerBalance[] = [{ skuId: "sku-1", locationKind: "TRANSITO", quantity: 6 }];
    const projected: LedgerBalance[] = [];

    const events = computeLedgerIntegrityDivergences(ledger, projected, BUSINESS_DATE, OCCURRED_AT);

    expect(events).toHaveLength(1);
    expect(events[0]?.after).toMatchObject({ quantity: 6 });
  });

  it("linha ausente no ledger conta como zero — projeção sobrando também é divergência", () => {
    const ledger: LedgerBalance[] = [];
    const projected: LedgerBalance[] = [{ skuId: "sku-1", locationKind: "RESERVADO", quantity: 3 }];

    const events = computeLedgerIntegrityDivergences(ledger, projected, BUSINESS_DATE, OCCURRED_AT);

    expect(events).toHaveLength(1);
    expect(events[0]?.before).toMatchObject({ quantity: 3 });
    expect(events[0]?.after).toMatchObject({ quantity: 0 });
  });

  it("chave de idempotência inclui a data de negócio — mesma divergência em dias diferentes não colide", () => {
    const ledger: LedgerBalance[] = [{ skuId: "sku-1", locationKind: "LOCAL", quantity: 5 }];
    const projected: LedgerBalance[] = [{ skuId: "sku-1", locationKind: "LOCAL", quantity: 0 }];

    const day1 = computeLedgerIntegrityDivergences(ledger, projected, "2026-08-23", OCCURRED_AT);
    const day2 = computeLedgerIntegrityDivergences(ledger, projected, "2026-08-24", OCCURRED_AT);

    expect(day1[0]?.dedupKey).not.toBe(day2[0]?.dedupKey);
  });

  it("SKUs e location_kind diferentes não se misturam", () => {
    const ledger: LedgerBalance[] = [
      { skuId: "sku-1", locationKind: "LOCAL", quantity: 10 },
      { skuId: "sku-1", locationKind: "RESERVADO", quantity: 2 },
      { skuId: "sku-2", locationKind: "LOCAL", quantity: 4 },
    ];
    const projected: LedgerBalance[] = [
      { skuId: "sku-1", locationKind: "LOCAL", quantity: 10 },
      { skuId: "sku-1", locationKind: "RESERVADO", quantity: 2 },
      { skuId: "sku-2", locationKind: "LOCAL", quantity: 999 },
    ];

    const events = computeLedgerIntegrityDivergences(ledger, projected, BUSINESS_DATE, OCCURRED_AT);

    expect(events).toHaveLength(1);
    expect(events[0]?.entityId).toBe("sku-2");
  });

  it("reprocessar o mesmo par duas vezes produz a mesma chave — idempotente", () => {
    const ledger: LedgerBalance[] = [{ skuId: "sku-1", locationKind: "LOCAL", quantity: 5 }];
    const projected: LedgerBalance[] = [{ skuId: "sku-1", locationKind: "LOCAL", quantity: 0 }];

    const first = computeLedgerIntegrityDivergences(ledger, projected, BUSINESS_DATE, OCCURRED_AT);
    const second = computeLedgerIntegrityDivergences(ledger, projected, BUSINESS_DATE, OCCURRED_AT);

    expect(first[0]?.dedupKey).toBe(second[0]?.dedupKey);
  });
});
