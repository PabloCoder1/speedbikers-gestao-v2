import { describe, expect, it } from "vitest";

import { iniciais, monogramaDeProduto } from "./initials.js";

/**
 * O monograma do avatar (A12, D-320) — três consumidores: o perfil e a marca no
 * shell, o autor da decisão no SKU e a gaveta de `/usuarios`. O que importa
 * fixar é que os três digam as MESMAS letras para a mesma pessoa.
 */
describe("iniciais", () => {
  it("usa a primeira letra das duas primeiras partes do nome", () => {
    expect(iniciais("João Martins")).toBe("JM");
    expect(iniciais("Speed Bikers Gestão")).toBe("SB");
  });

  it("um nome de uma parte só dá uma letra, não uma letra repetida", () => {
    expect(iniciais("E2E")).toBe("E");
  });

  it("o e-mail de reserva quebra em ponto e arroba, como o nome quebra em espaço", () => {
    expect(iniciais("joao.martins@loja.test")).toBe("JM");
    expect(iniciais("ana_souza@loja.test")).toBe("AS");
  });

  it("maiúscula mesmo quando o rótulo vem minúsculo", () => {
    expect(iniciais("gestor e2e")).toBe("GE");
  });

  it("vazio ou só espaço vira ?, nunca um círculo sem letra", () => {
    expect(iniciais("")).toBe("?");
    expect(iniciais("   ")).toBe("?");
  });

  it("rótulo feito só de separadores cai na primeira letra do texto", () => {
    expect(iniciais("@@")).toBe("@");
  });
});

/**
 * O monograma de PRODUTO (A13, D-321) — `/anuncios` e a gaveta do pedido. A
 * regra é outra que a de pessoa, e os casos fixam exatamente onde elas diferem.
 */
describe("monogramaDeProduto", () => {
  it("usa a primeira letra das duas primeiras palavras, ignorando o que não tem letra", () => {
    expect(monogramaDeProduto("Kit Relação E2E — vende e tem visita")).toBe("KR");
    expect(monogramaDeProduto("12 Pastilha de Freio")).toBe("Pd");
  });

  it("título de uma palavra dá DUAS letras dela — onde a regra de pessoa daria uma", () => {
    expect(monogramaDeProduto("Guidão")).toBe("Gu");
    expect(iniciais("Guidão")).toBe("G");
  });

  it("título sem letra nenhuma vira —, nunca um quadrado vazio", () => {
    expect(monogramaDeProduto("— 123")).toBe("—");
    expect(monogramaDeProduto("   ")).toBe("—");
  });
});
