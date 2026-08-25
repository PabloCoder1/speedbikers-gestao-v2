import { describe, expect, it } from "vitest";

import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("preserva caminho interno com query string — é o filtro da tela de origem", () => {
    expect(safeNext("/atendimento?status=RESOLVIDO")).toBe("/atendimento?status=RESOLVIDO");
    expect(safeNext("/vendas?days=90&account=offracer")).toBe("/vendas?days=90&account=offracer");
  });

  it("sem `next`, volta para a raiz", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext("")).toBe("/");
  });

  it.each([
    ["https://evil.example/phish", "URL absoluta"],
    ["http://evil.example", "URL absoluta sem caminho"],
    ["//evil.example/phish", "protocolo-relativa — passa numa checagem ingênua de primeiro caractere"],
    ["/\\evil.example", "barra invertida, normalizada por alguns navegadores"],
    ["javascript:alert(1)", "esquema executável"],
    ["evil.example", "sem barra inicial"],
  ])("recusa %s (%s) e cai na raiz", (candidate) => {
    expect(safeNext(candidate)).toBe("/");
  });
});
