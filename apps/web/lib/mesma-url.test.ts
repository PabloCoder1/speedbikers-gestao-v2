import { describe, expect, it } from "vitest";

import { mesmaUrl } from "./mesma-url";

describe("mesmaUrl (D-468)", () => {
  it("sem busca, só o caminho", () => {
    expect(mesmaUrl("/usuarios", {})).toBe("/usuarios");
    expect(mesmaUrl("/usuarios", { situacao: undefined })).toBe("/usuarios");
  });

  it("repete cada parâmetro como veio, inclusive os repetidos da ponte ao pedido", () => {
    expect(mesmaUrl("/compras/novo", { sku: ["a:3", "b:5"], fornecedor: "x" })).toBe(
      "/compras/novo?sku=a%3A3&sku=b%3A5&fornecedor=x",
    );
  });

  it("codifica o que precisa, sem perder o valor", () => {
    expect(mesmaUrl("/curva-abc", { busca: "freio & disco" })).toBe("/curva-abc?busca=freio+%26+disco");
  });
});
