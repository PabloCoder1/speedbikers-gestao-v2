import { describe, expect, it } from "vitest";

import { argumentosDaMarca, resolverContaDaVenda, resolverMarcaDaVenda } from "./vendas-ml-filtros";

describe("resolverMarcaDaVenda (D-237, na lib desde a D-602)", () => {
  it("marca, sem marca e todas, pela URL", () => {
    expect(resolverMarcaDaVenda({ marca: " Offracer " })).toEqual({ kind: "marca", value: "Offracer" });
    expect(resolverMarcaDaVenda({ semMarca: "1" })).toEqual({ kind: "sem_marca" });
    expect(resolverMarcaDaVenda({})).toEqual({ kind: "todas" });
    expect(resolverMarcaDaVenda({ marca: "  " })).toEqual({ kind: "todas" });
  });

  it("'sem marca' vence a marca quando as duas vêm: o recorte mais específico", () => {
    expect(resolverMarcaDaVenda({ marca: "Offracer", semMarca: "1" })).toEqual({ kind: "sem_marca" });
  });
});

describe("argumentosDaMarca", () => {
  it("cada recorte vira o argumento da RPC; 'todas' não manda chave nenhuma", () => {
    expect(argumentosDaMarca({ kind: "marca", value: "Offracer" })).toEqual({ p_supplier_brand: "Offracer" });
    expect(argumentosDaMarca({ kind: "sem_marca" })).toEqual({ p_sem_marca: true });
    expect(argumentosDaMarca({ kind: "todas" })).toEqual({});
  });
});

describe("resolverContaDaVenda", () => {
  const contas = [
    { id: "c-1", slug: "loja-a" },
    { id: "c-2", slug: "loja-b" },
  ];

  it("a conta pelo slug; desconhecido ou ausente cai em todas, em silêncio", () => {
    expect(resolverContaDaVenda({ account: "loja-b" }, contas)?.id).toBe("c-2");
    expect(resolverContaDaVenda({ account: "removida" }, contas)).toBeNull();
    expect(resolverContaDaVenda({}, contas)).toBeNull();
  });
});
