import { describe, expect, it } from "vitest";

import {
  agruparLinhas,
  alternarConta,
  antesDoHistoricoShopee,
  celulasDaFaixaMulticanal,
  NAO_SE_APLICA_SOB_MARCA,
  hrefDeVendas,
  hrefDoRecorte,
  marketplacesDoEscopo,
  metricasDoRecorte,
  pontosDoTotal,
  resolverContas,
  resolverEscopoDaTelaDeVendas,
  resolverEscopoVendas,
  resolverMetricaMulticanal,
  sobMarca,
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

describe("resolverEscopoDaTelaDeVendas (D-488)", () => {
  it("sem marketplace, a /vendas abre em Todos; o pedido explícito vale", () => {
    expect(resolverEscopoDaTelaDeVendas({})).toBe("todos");
    expect(resolverEscopoDaTelaDeVendas({ days: "7" })).toBe("todos");
    expect(resolverEscopoDaTelaDeVendas({ marketplace: "ml" })).toBe("ml");
    expect(resolverEscopoDaTelaDeVendas({ marketplace: "shopee" })).toBe("shopee");
    expect(resolverEscopoDaTelaDeVendas({ marketplace: "todos", account: "e2e-loja" })).toBe("todos");
  });

  it("o link de antes, com parâmetro que só o ML entende, continua no ML", () => {
    expect(resolverEscopoDaTelaDeVendas({ account: "e2e-loja" })).toBe("ml");
    expect(resolverEscopoDaTelaDeVendas({ marca: "Brembo" })).toBe("ml");
    expect(resolverEscopoDaTelaDeVendas({ semMarca: "1" })).toBe("ml");
    expect(resolverEscopoDaTelaDeVendas({ metric: "pedidos" })).toBe("ml");
    expect(resolverEscopoDaTelaDeVendas({ metric: "packs" })).toBe("ml");
    // Métrica que o consolidado também tem não decide nada.
    expect(resolverEscopoDaTelaDeVendas({ metric: "unidades" })).toBe("todos");
  });

  it("valor desconhecido não vira um recorte inventado", () => {
    expect(resolverEscopoDaTelaDeVendas({ marketplace: "amazon" })).toBe("todos");
  });
});

describe("hrefDeVendas", () => {
  const TODOS: RecorteDeVendas = { escopo: "todos", periodo: { days: 7 }, contas: [ML, LOJA], metrica: "compras" };

  it("o recorte inteiro na URL, sem o que é padrão — e Todos é o padrão da /vendas (D-488)", () => {
    expect(hrefDeVendas(TODOS)).toBe("/vendas?days=7&contas=ml-1%2Csp-1&metric=compras");
    expect(hrefDeVendas({ ...TODOS, periodo: { days: 30 }, contas: null, metrica: "faturamento" })).toBe("/vendas");
  });

  it("para a Shopee só vai a loja; o ML é explícito, sem conta nem a métrica do consolidado", () => {
    expect(hrefDeVendas(TODOS, { escopo: "shopee" })).toBe("/vendas?marketplace=shopee&days=7&contas=sp-1");
    expect(hrefDeVendas(TODOS, { escopo: "ml" })).toBe("/vendas?marketplace=ml&days=7");
  });

  it("do ML para o consolidado, o período vai junto", () => {
    const doMl: RecorteDeVendas = { escopo: "ml", periodo: { from: "2026-10-01", to: "2026-10-10" }, contas: null, metrica: "unidades" };

    expect(hrefDeVendas(doMl, { escopo: "todos" })).toBe("/vendas?from=2026-10-01&to=2026-10-10");
  });

  it("trocar a conta ou a métrica mantém o resto", () => {
    expect(hrefDeVendas(TODOS, { contas: null })).toBe("/vendas?days=7&metric=compras");
    expect(hrefDeVendas(TODOS, { metrica: "unidades" })).toBe("/vendas?days=7&contas=ml-1%2Csp-1&metric=unidades");
  });

  it("toda URL que sai daqui volta para o mesmo recorte", () => {
    for (const escopo of ["ml", "todos", "shopee"] as const) {
      const url = new URL(hrefDeVendas(TODOS, { escopo }), "http://local");

      expect(resolverEscopoDaTelaDeVendas(Object.fromEntries(url.searchParams))).toBe(escopo);
    }
  });
});

describe("celulasDaFaixaMulticanal (D-488)", () => {
  it("as quatro células do consolidado, com o anterior ao lado", () => {
    const celulas = celulasDaFaixaMulticanal(
      linha({ nivel: "TOTAL", receita_bruta: 1_600, compras: 16, unidades: 16, ticket_medio: 100 }),
      linha({ nivel: "TOTAL", receita_bruta: 400, compras: 3, unidades: 3, ticket_medio: 133.33 }),
    );

    expect(celulas.map((c) => c.metricId)).toEqual([
      "multicanal_receita_bruta",
      "multicanal_compras",
      "multicanal_unidades",
      "multicanal_ticket_medio",
    ]);
    expect(celulas.map((c) => c.label)).toEqual(["Receita bruta", "Compras", "Unidades vendidas", "Ticket médio"]);
    expect(celulas[1]?.value).toBe("16");
    expect(celulas[1]?.previous).toBe("3");
  });

  it("sem nada somável, o traço diz por quê; sem anterior, não há comparação", () => {
    const celulas = celulasDaFaixaMulticanal(null, null);

    expect(celulas.every((c) => c.value === "—" && c.previous === null)).toBe(true);
    expect(celulas[0]?.ressalva).toBe("nenhuma conta com venda somável neste recorte");
  });

  it("pedido Shopee de receita desconhecida fica fora da soma, e a célula diz quantos", () => {
    const [receita] = celulasDaFaixaMulticanal(linha({ nivel: "TOTAL", receita_bruta: 100, pedidos_sem_receita: 2 }), null);

    expect(receita?.ressalva).toBe("2 pedidos Shopee sem receita conhecida, fora da soma");
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

describe("a marca no recorte (D-622, C-72)", () => {
  const COM_MARCA: RecorteDeVendas = {
    escopo: "todos",
    periodo: { days: 7 },
    contas: null,
    metrica: "faturamento",
    marca: { kind: "marca", value: "Pro Tork" },
  };

  it("vai na URL com os nomes da tela do ML, com o Todos explícito, e atravessa para o ML e para a Shopee", () => {
    // Sem `marketplace`, a marca na URL abriria o ML (o link antigo, D-488): o Todos tem de dizer que é ele.
    expect(resolverEscopoDaTelaDeVendas(Object.fromEntries(new URL(hrefDeVendas(COM_MARCA), "http://local").searchParams))).toBe("todos");
    expect(hrefDeVendas(COM_MARCA)).toBe("/vendas?marketplace=todos&days=7&marca=Pro+Tork");
    expect(hrefDeVendas(COM_MARCA, { escopo: "ml" })).toBe("/vendas?marketplace=ml&days=7&marca=Pro+Tork");
    expect(hrefDeVendas(COM_MARCA, { escopo: "shopee" })).toBe("/vendas?marketplace=shopee&days=7&marca=Pro+Tork");
  });

  it("o \"sem marca\" é o semMarca=1, e tirar a marca a tira da URL", () => {
    expect(hrefDeVendas(COM_MARCA, { marca: { kind: "sem_marca" } })).toBe("/vendas?marketplace=todos&days=7&semMarca=1");
    expect(hrefDeVendas(COM_MARCA, { marca: { kind: "todas" } })).toBe("/vendas?days=7");
  });

  it("o /faturamento não tem marca: o link para ele não a leva", () => {
    expect(hrefDoRecorte("/faturamento", COM_MARCA)).not.toContain("marca");
  });

  it("sob marca, a compra sai do gráfico e a URL com metric=compras cai no faturamento", () => {
    expect(sobMarca(COM_MARCA)).toBe(true);
    expect(sobMarca({ marca: { kind: "todas" } })).toBe(false);
    expect(metricasDoRecorte(true).map((metrica) => metrica.key)).toEqual(["faturamento", "unidades"]);
    expect(resolverMetricaMulticanal("compras", true).key).toBe("faturamento");
    expect(resolverMetricaMulticanal("compras", false).key).toBe("compras");
  });

  it("sob marca, a faixa diz por que compras e ticket são \"—\"", () => {
    const celulas = celulasDaFaixaMulticanal(
      linha({ nivel: "TOTAL", receita_bruta: 100, unidades: 2, compras: null, ticket_medio: null }),
      null,
      true,
    );
    const [, compras, , ticket] = celulas;

    expect(compras?.value).toBe("—");
    expect(compras?.ressalva).toBe(NAO_SE_APLICA_SOB_MARCA);
    expect(ticket?.ressalva).toBe(NAO_SE_APLICA_SOB_MARCA);
    expect(celulas[0]?.ressalva).toBeUndefined();
  });
});
