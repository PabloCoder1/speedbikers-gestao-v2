import { describe, expect, it } from "vitest";

import {
  TAMANHO_DO_RANKING,
  contaDeTeste,
  ordemDoRanking,
  separarVendasDoSku,
  type VendaDoSkuPorConta,
} from "./vendas-por-sku";
import { METRICAS_MULTICANAL, resolverMetricaMulticanal } from "./vendas-multicanal";

describe("ordemDoRanking", () => {
  it("acompanha a métrica do gráfico; compras cai na receita, que o contrato sabe ordenar", () => {
    expect(ordemDoRanking(resolverMetricaMulticanal("faturamento"))).toBe("receita");
    expect(ordemDoRanking(resolverMetricaMulticanal("unidades"))).toBe("unidades");
    expect(ordemDoRanking(resolverMetricaMulticanal("compras"))).toBe("receita");
  });

  it("toda métrica do consolidado tem uma ordem, e o ranking é o top 10 da tela do ML", () => {
    expect(METRICAS_MULTICANAL.map((m) => ordemDoRanking(m))).toEqual(["receita", "unidades", "receita"]);
    expect(TAMANHO_DO_RANKING).toBe(10);
  });
});

describe("separarVendasDoSku", () => {
  const conta = (
    nome: string,
    marketplace: "ML" | "SHOPEE",
    environment = "live",
  ): VendaDoSkuPorConta => ({
    nivel: "CONTA",
    marketplace,
    account_id: `${marketplace}-${nome}`,
    account_name: nome,
    environment,
    unidades: 1,
    receita_bruta: 10,
    itens_sem_receita: 0,
    compras: 1,
    preco_medio: 10,
  });
  const total: VendaDoSkuPorConta = {
    nivel: "TOTAL",
    marketplace: null,
    account_id: null,
    account_name: null,
    environment: null,
    unidades: 2,
    receita_bruta: 20,
    itens_sem_receita: 0,
    compras: 2,
    preco_medio: 10,
  };

  it("o TOTAL à parte; o Mercado Livre antes da Shopee e, dentro de cada um, por nome", () => {
    const loja = conta("Speed Bikers Oficial", "SHOPEE");
    const b = conta("Loja B", "ML");
    const a = conta("Loja A", "ML");

    expect(separarVendasDoSku([loja, total, b, a])).toEqual({ total, contas: [a, b, loja] });
  });

  it("sem TOTAL (só a loja de teste vendeu) não há soma — e isso não é zero", () => {
    const teste = conta("Loja de teste", "SHOPEE", "sandbox");

    expect(separarVendasDoSku([teste])).toEqual({ total: null, contas: [teste] });
    expect(contaDeTeste(teste)).toBe(true);
    expect(contaDeTeste(conta("Loja A", "ML"))).toBe(false);
  });
});
