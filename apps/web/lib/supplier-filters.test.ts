import { describe, expect, it } from "vitest";

import {
  PAGE_SIZE,
  buildSupplierHref,
  resolveSupplierFilters,
  resolveSupplierOrder,
  resolveSupplierSearch,
  resolveSupplierState,
  summarizeSupplierWindow,
  type SupplierFilters,
} from "./supplier-filters";

const base: SupplierFilters = { state: "todos", order: "nome", search: null, page: 1 };

describe("estado do fornecedor", () => {
  it("resolve os cinco recortes", () => {
    expect(resolveSupplierState("todos")).toBe("todos");
    expect(resolveSupplierState("ativos")).toBe("ativos");
    expect(resolveSupplierState("inativos")).toBe("inativos");
    // D-366: os dois que saem dos pedidos de compra.
    expect(resolveSupplierState("em_aberto")).toBe("em_aberto");
    expect(resolveSupplierState("sem_pedido")).toBe("sem_pedido");
  });

  it("valor desconhecido cai em todos, que era o comportamento anterior", () => {
    expect(resolveSupplierState("arquivados")).toBe("todos");
    expect(resolveSupplierState(undefined)).toBe("todos");
  });

  /**
   * O brief §24 pede origem, marcas, lead time, cobertura alvo e política de
   * reposição POR FORNECEDOR. Nada disso existe: `skus.supplier_id` não existe
   * de propósito (D-174) e `replenishment_settings` é escopada por
   * organização, marca ou SKU. Nenhuma delas pode virar recorte pela URL.
   */
  it("as dimensões que o brief pede e o modelo não tem são ignoradas", () => {
    expect(resolveSupplierFilters({ marca: "GIVI", leadTime: "15", origem: "importado" })).toEqual(base);
  });
});

describe("href", () => {
  it("o default fica FORA da URL", () => {
    expect(buildSupplierHref(base, {})).toBe("/fornecedores");
  });

  it("trocar de filtro volta para a página 1; paginar preserva o recorte", () => {
    const atual: SupplierFilters = { state: "ativos", order: "nome", search: null, page: 3 };

    expect(buildSupplierHref(atual, { state: "inativos" })).toBe("/fornecedores?estado=inativos");
    expect(buildSupplierHref(atual, { page: 2 })).toBe("/fornecedores?estado=ativos&pagina=2");
  });

  it("busca e ordem entram na URL e sobrevivem à troca de recorte", () => {
    const atual: SupplierFilters = { state: "todos", order: "valor", search: "navetec", page: 2 };

    expect(buildSupplierHref(atual, { state: "em_aberto" })).toBe(
      "/fornecedores?busca=navetec&estado=em_aberto&ordem=valor",
    );
    expect(buildSupplierHref(atual, { order: "nome" })).toBe("/fornecedores?busca=navetec");
    expect(buildSupplierHref(atual, { search: null })).toBe("/fornecedores?ordem=valor");
  });
});

describe("busca e ordem", () => {
  it("busca vazia ou só espaços é ausência de busca", () => {
    expect(resolveSupplierSearch("   ")).toBeNull();
    expect(resolveSupplierSearch(undefined)).toBeNull();
    expect(resolveSupplierSearch(["a", "b"])).toBeNull();
    expect(resolveSupplierSearch("  Navetec ")).toBe("Navetec");
  });

  it("a busca tem teto: a URL é entrada de terceiro", () => {
    expect(resolveSupplierSearch("x".repeat(500))).toHaveLength(80);
  });

  it("ordem fora da lista cai no nome", () => {
    expect(resolveSupplierOrder("valor")).toBe("valor");
    expect(resolveSupplierOrder("recente")).toBe("recente");
    expect(resolveSupplierOrder("em_aberto")).toBe("em_aberto");
    expect(resolveSupplierOrder("created_at; drop")).toBe("nome");
  });
});

describe("janela declarada", () => {
  /**
   * A tela lia `.limit(200)` e não dizia nada — nem total, nem página
   * seguinte. Com 260 fornecedores, 60 eram invisíveis sem aviso (D-131).
   */
  it("com mais fornecedores que a página, a frase declara o corte", () => {
    const janela = summarizeSupplierWindow(1, 260, PAGE_SIZE);

    expect(janela.label).toBe("Mostrando 1 a 50 de 260 fornecedores.");
    expect(janela.totalPages).toBe(6);
  });

  it("flexiona pelo total", () => {
    expect(summarizeSupplierWindow(1, 1, 1).label).toBe("1 fornecedor.");
    expect(summarizeSupplierWindow(1, 3, 3).label).toBe("3 fornecedores.");
  });

  it("vazio diz por que está vazio", () => {
    expect(summarizeSupplierWindow(1, 0, 0).label).toBe("Nenhum fornecedor com estes filtros.");
  });
});
