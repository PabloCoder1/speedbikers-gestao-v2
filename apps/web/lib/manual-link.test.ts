import { describe, expect, it } from "vitest";

import { parseManualLink } from "./manual-link.js";

const CONTA = "aaaaaaaa-0000-4000-8000-000000000001";
const SKU = "bbbbbbbb-0000-4000-8000-000000000002";

const BASE = { mlAccountId: CONTA, itemId: "MLB123456789", variationId: "", skuId: SKU };

describe("parseManualLink", () => {
  it("anúncio sem variação: campo vazio vira NULL, não string vazia", () => {
    const result = parseManualLink(BASE);

    expect(result).toEqual({
      ok: true,
      value: { mlAccountId: CONTA, itemId: "MLB123456789", variationId: null, skuId: SKU },
    });
  });

  it("anúncio com variação preserva o id", () => {
    const result = parseManualLink({ ...BASE, variationId: "45339262332" });

    expect(result.ok && result.value.variationId).toBe("45339262332");
  });

  it("normaliza caixa e espaço colados de um copiar/colar", () => {
    const result = parseManualLink({ ...BASE, itemId: "  mlb123456789 ", variationId: " 987 " });

    expect(result.ok && result.value.itemId).toBe("MLB123456789");
    expect(result.ok && result.value.variationId).toBe("987");
  });

  it("MLB fora do formato é recusado citando o que foi digitado", () => {
    const result = parseManualLink({ ...BASE, itemId: "123456789" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("123456789");
    expect(!result.ok && result.message).toContain("MLB seguido de números");
  });

  it("colar o MLB no campo de variação é recusado — o erro real de digitação", () => {
    const result = parseManualLink({ ...BASE, variationId: "MLB123456789" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("só números");
  });

  it("MLB vazio pede o MLB, não reclama de formato", () => {
    const result = parseManualLink({ ...BASE, itemId: "   " });

    expect(!result.ok && result.message).toBe("Informe o MLB do anúncio.");
  });

  it("conta ou SKU ausentes são recusados antes de qualquer consulta", () => {
    expect(parseManualLink({ ...BASE, mlAccountId: "" }).ok).toBe(false);
    expect(parseManualLink({ ...BASE, skuId: "não-é-uuid" }).ok).toBe(false);
  });
});
