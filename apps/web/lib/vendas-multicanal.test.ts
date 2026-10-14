import { describe, expect, it } from "vitest";

import {
  agruparLinhas,
  alternarConta,
  antesDoHistoricoShopee,
  hrefDeVendas,
  marketplacesDoEscopo,
  pontosDoTotal,
  resolverContas,
  resolverEscopoVendas,
  resolverMetricaMulticanal,
  type ContaDoSeletor,
  type DiaDeVendas,
  type LinhaDeVendas,
  type RecorteDeVendas,
} from "./vendas-multicanal";

const ML: ContaDoSeletor = { account_id: "ml-1", marketplace: "ML", name: "Loja E2E", environment: "live" };
const LOJA: ContaDoSeletor = { account_id: "sp-1", marketplace: "SHOPEE", name: "Speedbikers", environment: "live" };
const TESTE: ContaDoSeletor = { account_id: "sp-2", marketplace: "SHOPEE", name: "Loja de teste", environment: "sandbox" };
const CONTAS = [ML, LOJA, TESTE];

describe("resolverEscopoVendas", () => {
  it("sem parâmetro, ou desconhecido, é a tela do Mercado Livre de sempre", () => {
    expect(resolverEscopoVendas(undefined)).toBe("ml");
    expect(resolverEscopoVendas("amazon")).toBe("ml");
    expect(resolverEscopoVendas("todos")).toBe("todos");
    expect(resolverEscopoVendas("shopee")).toBe("shopee");
  });

  it("o recorte vira o p_marketplaces do contrato", () => {
    expect(marketplacesDoEscopo("todos")).toEqual(["ML", "SHOPEE"]);
    expect(marketplacesDoEscopo("shopee")).toEqual(["SHOPEE"]);
  });
});

describe("resolverContas", () => {
  it("as contas do link que a pessoa alcança, um valor só separado por vírgula", () => {
    expect(resolverContas("ml-1,sp-1", CONTAS, "todos")).toEqual({ selecionadas: [ML, LOJA], descartadas: 0 });
  });

  it("no recorte Shopee, a conta do ML não cabe — e a tela fica sabendo que ela caiu", () => {
    expect(resolverContas("ml-1,sp-1", CONTAS, "shopee")).toEqual({ selecionadas: [LOJA], descartadas: 1 });
  });

  it("id desconhecido (sem permissão ou apagado) sai, e nenhuma válida é todas", () => {
    expect(resolverContas("xyz", CONTAS, "todos")).toEqual({ selecionadas: null, descartadas: 1 });
    expect(resolverContas(undefined, CONTAS, "todos")).toEqual({ selecionadas: null, descartadas: 0 });
    expect(resolverContas(" , ", CONTAS, "todos")).toEqual({ selecionadas: null, descartadas: 0 });
  });

  it("repetido no link conta uma vez", () => {
    expect(resolverContas("sp-1,sp-1", CONTAS, "todos").selecionadas).toEqual([LOJA]);
  });
});

describe("alternarConta", () => {
  it("liga e desliga; a última desligada volta para todas", () => {
    expect(alternarConta(null, LOJA)).toEqual([LOJA]);
    expect(alternarConta([LOJA], ML)).toEqual([LOJA, ML]);
    expect(alternarConta([LOJA, ML], LOJA)).toEqual([ML]);
    expect(alternarConta([ML], ML)).toBeNull();
  });
});

describe("hrefDeVendas", () => {
  const TODOS: RecorteDeVendas = { escopo: "todos", periodo: { days: 7 }, contas: [ML, LOJA], metrica: "compras" };

  it("o recorte inteiro na URL, sem o que é padrão", () => {
    expect(hrefDeVendas(TODOS)).toBe("/vendas?marketplace=todos&days=7&contas=ml-1%2Csp-1&metric=compras");
    expect(hrefDeVendas({ ...TODOS, periodo: { days: 30 }, contas: null, metrica: "faturamento" })).toBe(
      "/vendas?marketplace=todos",
    );
  });

  it("para a Shopee só vai a loja; para o ML, nem conta nem a métrica do consolidado", () => {
    expect(hrefDeVendas(TODOS, { escopo: "shopee" })).toBe("/vendas?marketplace=shopee&days=7&contas=sp-1");
    expect(hrefDeVendas(TODOS, { escopo: "ml" })).toBe("/vendas?days=7");
  });

  it("do ML para o consolidado, o período vai junto", () => {
    const doMl: RecorteDeVendas = { escopo: "ml", periodo: { from: "2026-10-01", to: "2026-10-10" }, contas: null, metrica: "unidades" };

    expect(hrefDeVendas(doMl, { escopo: "todos" })).toBe("/vendas?marketplace=todos&from=2026-10-01&to=2026-10-10");
  });

  it("trocar a conta ou a métrica mantém o resto", () => {
    expect(hrefDeVendas(TODOS, { contas: null })).toBe("/vendas?marketplace=todos&days=7&metric=compras");
    expect(hrefDeVendas(TODOS, { metrica: "unidades" })).toBe(
      "/vendas?marketplace=todos&days=7&contas=ml-1%2Csp-1&metric=unidades",
    );
  });
});

describe("resolverMetricaMulticanal", () => {
  it("faturamento, unidades e compras — o pedido não é comparável e não está aqui", () => {
    expect(resolverMetricaMulticanal("compras").definitionId).toBe("multicanal_compras");
    expect(resolverMetricaMulticanal("pedidos").key).toBe("faturamento");
    expect(resolverMetricaMulticanal(undefined).definitionId).toBe("multicanal_receita_bruta");
  });
});

function linha(parcial: Partial<LinhaDeVendas> & Pick<LinhaDeVendas, "nivel">): LinhaDeVendas {
  return {
    marketplace: null,
    account_id: null,
    account_name: null,
    environment: null,
    compras: null,
    unidades: null,
    receita_bruta: null,
    pedidos_sem_receita: null,
    ticket_medio: null,
    pedidos_ml: null,
    recebido: null,
    pedidos_sem_recebido: null,
    ultima_atualizacao: null,
    ...parcial,
  };
}

describe("agruparLinhas", () => {
  it("TOTAL à parte e, por marketplace (ML primeiro), a soma e as contas — sem somar nada", () => {
    const linhas = [
      linha({ nivel: "CONTA", marketplace: "SHOPEE", account_id: "sp-2", environment: "sandbox", compras: 3 }),
      linha({ nivel: "TOTAL", compras: 12 }),
      linha({ nivel: "MARKETPLACE", marketplace: "ML", compras: 12 }),
      linha({ nivel: "CONTA", marketplace: "ML", account_id: "ml-1", compras: 12 }),
    ];
    const { total, grupos } = agruparLinhas(linhas);

    expect(total?.compras).toBe(12);
    expect(grupos.map((g) => g.marketplace)).toEqual(["ML", "SHOPEE"]);
    // Só loja de teste: a Shopee aparece com as contas, sem soma (o SQL não a soma).
    expect(grupos[1]?.soma).toBeNull();
    expect(grupos[1]?.contas.map((c) => c.account_id)).toEqual(["sp-2"]);
  });

  it("sem nada somável, não há total", () => {
    expect(agruparLinhas([linha({ nivel: "CONTA", marketplace: "SHOPEE" })]).total).toBeNull();
  });
});

describe("pontosDoTotal", () => {
  const DIAS: DiaDeVendas[] = [
    { dia: "2026-10-10", marketplace: "ML", compras: 2, unidades: 3, receita_bruta: 200, pedidos_sem_receita: 0 },
    { dia: "2026-10-10", marketplace: null, compras: 2, unidades: 3, receita_bruta: 200, pedidos_sem_receita: 0 },
    { dia: "2026-10-11", marketplace: "SHOPEE", compras: 1, unidades: 4, receita_bruta: null, pedidos_sem_receita: 1 },
    { dia: "2026-10-11", marketplace: null, compras: 1, unidades: 4, receita_bruta: null, pedidos_sem_receita: 1 },
  ];

  it("só as linhas do TOTAL, na forma do gráfico", () => {
    const { pontos } = pontosDoTotal(DIAS, resolverMetricaMulticanal("compras"));

    expect(pontos.map((p) => [p.metric_date, p.purchases_count])).toEqual([
      ["2026-10-10", 2],
      ["2026-10-11", 1],
    ]);
  });

  it("dia de receita desconhecida fica fora da linha de faturamento e é contado — nunca vira zero", () => {
    const { pontos, diasSemReceita } = pontosDoTotal(DIAS, resolverMetricaMulticanal("faturamento"));

    expect(pontos.map((p) => p.metric_date)).toEqual(["2026-10-10"]);
    expect(diasSemReceita).toBe(1);
  });
});

describe("antesDoHistoricoShopee", () => {
  it("o período que começa antes dos 90 dias da Shopee é avisado", () => {
    expect(antesDoHistoricoShopee("2026-07-01", "2026-10-14")).toBe(true);
    expect(antesDoHistoricoShopee("2026-09-15", "2026-10-14")).toBe(false);
  });
});
