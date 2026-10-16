import { describe, expect, it } from "vitest";

import { summarize } from "./summarize";

describe("resumo da linha na conferência", () => {
  it("mostra o preço como dinheiro, e não como número solto", () => {
    // O bug que esta tela existe para pegar: 174,90 lido como 17490. Formatado
    // como moeda, a diferença salta aos olhos de quem está com a planilha
    // aberta ao lado.
    const line = summarize("PRODUCTS", { title: "Painel", retailPrice: 174.9 });

    expect(line).toContain("R$");
    expect(line).toContain("174,90");
  });

  it("marca produto em estoque inativo", () => {
    // Não é lixo: é produto que a loja está terminando de zerar. Precisa
    // aparecer na conferência.
    const line = summarize("PRODUCTS", { title: "Farol", isDiscontinued: true });

    expect(line).toContain("estoque inativo");
  });

  it("mostra anúncio e variação do vínculo", () => {
    const line = summarize("LINKS", {
      storeLabel: "ML - Speedbikers (loja 1)",
      ref: { kind: "ITEM", itemId: "MLB1722724235", variationId: "205704879161" },
    });

    expect(line).toContain("MLB1722724235");
    expect(line).toContain("205704879161");
  });

  it("mostra o produto do catálogo próprio quando o vínculo é MLBU", () => {
    const line = summarize("LINKS", {
      storeLabel: "ML - GMR",
      ref: { kind: "USER_PRODUCT", userProductId: "MLBU123" },
    });

    expect(line).toContain("MLBU123");
  });

  it("mostra armazém e saldos do estoque", () => {
    const line = summarize("STOCK", {
      warehouse: "ESTOQUE LOJA",
      onHand: 10,
      available: 8,
      reserved: 2,
    });

    expect(line).toContain("ESTOQUE LOJA");
    expect(line).toContain("atual 10");
    expect(line).toContain("disponível 8");
  });

  it("não quebra com payload de formato antigo ou inesperado", () => {
    // `jsonb` gravado por uma versão anterior do parser é `unknown` de verdade.
    // Degradar é aceitável; derrubar a página inteira não é.
    expect(summarize("PRODUCTS", null)).toBe("—");
    expect(summarize("PRODUCTS", "texto solto")).toBe("—");
    expect(summarize("PRODUCTS", [1, 2, 3])).toBe("—");
    expect(summarize("LINKS", { storeLabel: "ML", ref: "quebrado" })).toBe("ML");
    expect(summarize("STOCK", {})).toBe("—");
  });

  it("ignora número não finito em vez de escrever NaN na tela", () => {
    expect(summarize("STOCK", { warehouse: "LOJA", onHand: Number.NaN })).toBe("LOJA");
  });
});
