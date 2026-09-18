import { describe, expect, it } from "vitest";

import { filtrarPaginas, type PaginaDoMenu } from "./command-pages";

const PAGINAS: PaginaDoMenu[] = [
  { label: "Estoque", href: "/estoque", grupo: "Estoque" },
  { label: "Movimentações", href: "/estoque/movimentacoes", grupo: "Estoque" },
  { label: "Usuários", href: "/usuarios", grupo: "Administração" },
  { label: "Central Full", href: "/full", grupo: "Estoque" },
];

describe("filtrarPaginas", () => {
  it("ignora acento e caixa", () => {
    expect(filtrarPaginas(PAGINAS, "USUARIOS").map((p) => p.href)).toEqual(["/usuarios"]);
    expect(filtrarPaginas(PAGINAS, "movimenta").map((p) => p.href)).toEqual(["/estoque/movimentacoes"]);
  });

  it("o que começa com o texto vem antes do que só está no grupo", () => {
    expect(filtrarPaginas(PAGINAS, "estoque").map((p) => p.href)).toEqual(["/estoque", "/estoque/movimentacoes", "/full"]);
  });

  it("texto vazio não lista nada, e o limite vale", () => {
    expect(filtrarPaginas(PAGINAS, "  ")).toEqual([]);
    expect(filtrarPaginas(PAGINAS, "e", 2)).toHaveLength(2);
  });
});
