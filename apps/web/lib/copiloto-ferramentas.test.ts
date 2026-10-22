import { describe, expect, it } from "vitest";

import { rotuloDaFerramenta } from "./copiloto-ferramentas";

/** As nove ferramentas de `apps/api/src/copilot-chat.ts` (D-646, com as duas do C-84). */
const FERRAMENTAS_DA_API = [
  "sales_summary",
  "sales_period_comparison",
  "sales_account_comparison",
  "sales_sku_declines",
  "resolve_catalog_entity",
  "sku_replenishment",
  "listing_performance",
  "marketplace_sales_summary",
  "marketplace_sku_sales",
];

describe("rotuloDaFerramenta (D-646)", () => {
  it("toda ferramenta da api tem rótulo — nenhuma aparece pelo nome cru", () => {
    for (const ferramenta of FERRAMENTAS_DA_API) {
      expect(rotuloDaFerramenta(ferramenta)).not.toBe(ferramenta);
    }
  });

  it("as duas com a Shopee dizem o canal (C-84)", () => {
    expect(rotuloDaFerramenta("marketplace_sales_summary")).toBe("consultou vendas por canal");
    expect(rotuloDaFerramenta("marketplace_sku_sales")).toBe("consultou os SKUs mais vendidos por canal");
  });

  it("a desconhecida aparece pelo nome, em vez de sumir", () => {
    expect(rotuloDaFerramenta("ferramenta_nova")).toBe("ferramenta_nova");
  });
});
