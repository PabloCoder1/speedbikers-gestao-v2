import { describe, expect, it } from "vitest";

import {
  canaisPedidos,
  canalDaLinha,
  canalDaUrl,
  canalParaUrl,
  chaveDoDiagnostico,
  eventoValeParaOCanal,
} from "./diagnostico-por-canal";

describe("o diagnóstico por canal (D-644, C-83)", () => {
  it("só pede os dois canais com loja Shopee; sem loja, o ML de sempre (sem parâmetro)", () => {
    expect(canaisPedidos(2)).toEqual(["ML", "SHOPEE"]);
    expect(canaisPedidos(0)).toBeNull();
    // A contagem que falhou não inventa a Shopee.
    expect(canaisPedidos(null)).toBeNull();
  });

  it("a linha sem a coluna (antes da migration) é do ML, e valor estranho também", () => {
    expect(canalDaLinha("SHOPEE")).toBe("SHOPEE");
    expect(canalDaLinha("ML")).toBe("ML");
    expect(canalDaLinha(undefined)).toBe("ML");
    expect(canalDaLinha("tiktok")).toBe("ML");
  });

  it("o evento do SKU vale para os dois canais; o do anúncio, só para o dele", () => {
    expect(eventoValeParaOCanal(null, "SHOPEE")).toBe(true);
    expect(eventoValeParaOCanal(null, "ML")).toBe(true);
    expect(eventoValeParaOCanal("SHOPEE", "SHOPEE")).toBe(true);
    expect(eventoValeParaOCanal("SHOPEE", "ML")).toBe(false);
    expect(eventoValeParaOCanal("ML", "SHOPEE")).toBe(false);
  });

  it("a chave separa o mesmo SKU nos dois canais, e a URL leva o canal em minúsculas", () => {
    expect(chaveDoDiagnostico("s1", "ML")).not.toBe(chaveDoDiagnostico("s1", "SHOPEE"));
    expect(canalDaUrl(canalParaUrl("SHOPEE"))).toBe("SHOPEE");
    expect(canalDaUrl(canalParaUrl("ML"))).toBe("ML");
    expect(canalDaUrl("SHOPEE")).toBeNull();
  });
});
