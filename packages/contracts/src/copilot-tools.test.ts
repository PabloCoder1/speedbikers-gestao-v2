import { describe, expect, it } from "vitest";

import {
  listingPerformanceInputSchema,
  marketplaceSalesSummaryInputSchema,
  marketplaceSkuSalesInputSchema,
  salesAccountComparisonInputSchema,
  salesPeriodComparisonInputSchema,
  salesSkuDeclinesInputSchema,
  salesSummaryInputSchema,
} from "./copilot-tools.js";

const ACC_1 = "11111111-0000-4000-8000-000000000001";
const ACC_2 = "22222222-0000-4000-8000-000000000002";

describe("copilot-tools date range invariants (D-798)", () => {
  const cases = [
    {
      name: "salesSummaryInputSchema",
      schema: salesSummaryInputSchema,
      base: {},
    },
    {
      name: "salesPeriodComparisonInputSchema",
      schema: salesPeriodComparisonInputSchema,
      base: {},
    },
    {
      name: "salesAccountComparisonInputSchema",
      schema: salesAccountComparisonInputSchema,
      base: { mlAccountIds: [ACC_1, ACC_2] },
    },
    {
      name: "salesSkuDeclinesInputSchema",
      schema: salesSkuDeclinesInputSchema,
      base: {},
    },
    {
      name: "listingPerformanceInputSchema",
      schema: listingPerformanceInputSchema,
      base: { itemId: "MLB123456", mlAccountId: ACC_1 },
    },
    {
      name: "marketplaceSalesSummaryInputSchema",
      schema: marketplaceSalesSummaryInputSchema,
      base: {},
    },
    {
      name: "marketplaceSkuSalesInputSchema",
      schema: marketplaceSkuSalesInputSchema,
      base: {},
    },
  ] as const;

  for (const { name, schema, base } of cases) {
    it(`${name}: aceita dateFrom <= dateTo e recusa janela invertida (dateFrom > dateTo)`, () => {
      expect(schema.safeParse({ ...base, dateFrom: "2026-11-10", dateTo: "2026-11-10" }).success).toBe(true);
      expect(schema.safeParse({ ...base, dateFrom: "2026-11-10", dateTo: "2026-11-20" }).success).toBe(true);
      expect(schema.safeParse({ ...base, dateFrom: "2026-11-20", dateTo: "2026-11-10" }).success).toBe(false);
    });
  }
});
