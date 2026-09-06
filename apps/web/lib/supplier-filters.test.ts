import { describe, expect, it } from "vitest";

import {
  PAGE_SIZE,
  buildSupplierHref,
  resolveSupplierFilters,
  resolveSupplierState,
  summarizeSupplierWindow,
  type SupplierFilters,
} from "./supplier-filters";

const base: SupplierFilters = { state: "todos", page: 1 };

describe("estado do fornecedor", () => {
  it("resolve os três recortes", () => {
    expect(resolveSupplierState("todos")).toBe("todos");
    expect(resolveSupplierState("ativos")).toBe("ativos");
    expect(resolveSupplierState("inativos")).toBe("inativos");
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
    const atual: SupplierFilters = { state: "ativos", page: 3 };

    expect(buildSupplierHref(atual, { state: "inativos" })).toBe("/fornecedores?estado=inativos");
    expect(buildSupplierHref(atual, { page: 2 })).toBe("/fornecedores?estado=ativos&pagina=2");
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
