import { describe, expect, it } from "vitest";

import { includesPurchaseOrderValues, purchaseOrderExportMode } from "./mode";

describe("modo da exportação de pedido", () => {
  it("protege o custo quando a URL não escolhe a versão interna", () => {
    expect(purchaseOrderExportMode(new Request("https://app.test/compras/id/export/pdf"))).toBe("WITHOUT_VALUES");
    expect(purchaseOrderExportMode(new Request("https://app.test/compras/id/export/xlsx?valores=qualquer"))).toBe("WITHOUT_VALUES");
  });

  it("inclui valores somente quando a opção interna é explícita", () => {
    const mode = purchaseOrderExportMode(new Request("https://app.test/compras/id/export/pdf?valores=com"));

    expect(mode).toBe("WITH_VALUES");
    expect(includesPurchaseOrderValues(mode)).toBe(true);
    expect(includesPurchaseOrderValues("WITHOUT_VALUES")).toBe(false);
  });
});
