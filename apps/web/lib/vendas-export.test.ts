import { describe, expect, it } from "vitest";

import { contasParaCsv, diasDoMlParaCsv, diasParaCsv, hrefDaExportacao } from "./vendas-export";
import type { DiaDeVendas, LinhaDeVendas } from "./vendas-multicanal";

/** As linhas do documento, sem o BOM e sem a quebra final. */
function linhas(csv: string): string[] {
  return csv.replace(/^\uFEFF/u, "").replace(/\r\n$/u, "").split("\r\n");
}

const dia = (data: string, marketplace: DiaDeVendas["marketplace"], receita: number | null): DiaDeVendas => ({
  dia: data,
  marketplace,
  compras: 3,
  unidades: 4,
  receita_bruta: receita,
  pedidos_sem_receita: receita === null ? 1 : 0,
});

describe("diasParaCsv", () => {
  // Fora de ordem de propósito: a ordem do arquivo é do dia, e no dia ML, Shopee e o total.
  const dias = [
    dia("2026-10-15", null, 300.5),
    dia("2026-10-14", "SHOPEE", null),
    dia("2026-10-15", "SHOPEE", 100.5),
    dia("2026-10-14", null, 200),
    dia("2026-10-15", "ML", 200),
    dia("2026-10-14", "ML", 200),
  ];

  it("no 'Todos', cada dia com o Mercado Livre, a Shopee e o total do dia, na vírgula decimal", () => {
    expect(linhas(diasParaCsv(dias, "todos"))).toEqual([
      "Dia;Marketplace;Receita bruta;Pedidos sem receita conhecida;Compras;Unidades",
      "14/10/2026;Mercado Livre;200;0;3;4",
      // Receita desconhecida é célula vazia, nunca zero; os pedidos sem ela são ditos.
      "14/10/2026;Shopee;;1;3;4",
      "14/10/2026;Todos os marketplaces;200;0;3;4",
      "15/10/2026;Mercado Livre;200;0;3;4",
      "15/10/2026;Shopee;100,5;0;3;4",
      "15/10/2026;Todos os marketplaces;300,5;0;3;4",
    ]);
  });

  it("no recorte de um marketplace, o total do dia sai: ele repetiria a linha do marketplace", () => {
    const shopee = linhas(diasParaCsv(dias.filter((d) => d.marketplace !== "ML"), "shopee"));

    expect(shopee).toHaveLength(1 + 2);
    expect(shopee.some((linha) => linha.includes("Todos os marketplaces"))).toBe(false);
  });
});

const linha = (parcial: Partial<LinhaDeVendas> & Pick<LinhaDeVendas, "nivel">): LinhaDeVendas => ({
  marketplace: null,
  account_id: null,
  account_name: null,
  environment: null,
  compras: 10,
  unidades: 12,
  receita_bruta: 1000,
  pedidos_sem_receita: 0,
  ticket_medio: 100,
  pedidos_ml: null,
  recebido: null,
  pedidos_sem_recebido: null,
  ultima_atualizacao: null,
  ...parcial,
});

describe("contasParaCsv", () => {
  const resumo: LinhaDeVendas[] = [
    linha({ nivel: "CONTA", marketplace: "SHOPEE", account_id: "s-teste", account_name: "Loja de teste", environment: "sandbox" }),
    linha({ nivel: "TOTAL", receita_bruta: 1500.75 }),
    linha({ nivel: "MARKETPLACE", marketplace: "SHOPEE", receita_bruta: 500.75, recebido: 400, pedidos_sem_recebido: 1 }),
    linha({ nivel: "CONTA", marketplace: "ML", account_id: "m-1", account_name: "Conta ML", environment: "live", pedidos_ml: 11 }),
    linha({ nivel: "MARKETPLACE", marketplace: "ML", pedidos_ml: 11 }),
    linha({ nivel: "CONTA", marketplace: "SHOPEE", account_id: "s-1", account_name: "Loja Real", environment: "live", receita_bruta: 500.75, recebido: 400 }),
    // Lida nunca: tudo nulo na linha dela, e a tela diz "pedidos ainda não lidos".
    linha({
      nivel: "CONTA",
      marketplace: "SHOPEE",
      account_id: "s-2",
      account_name: "Loja Nova",
      environment: "live",
      compras: null,
      unidades: null,
      receita_bruta: null,
      ticket_medio: null,
    }),
  ];

  it("na ordem da tabela da tela: o total, e cada marketplace com a soma e as contas abaixo", () => {
    const [cabecalho, ...corpo] = linhas(contasParaCsv(resumo, "todos"));

    expect(cabecalho).toBe(
      "Linha;Marketplace;Conta ou loja;Ambiente;Receita bruta;Pedidos sem receita conhecida;Compras;Unidades;Ticket médio;Pedidos do ML;Recebido (Shopee);Aguardando o financeiro;Atualizado até;Observação",
    );
    expect(corpo.map((l) => l.split(";").slice(0, 3).join(";"))).toEqual([
      "Total;Todos os marketplaces;",
      "Soma do marketplace;Mercado Livre;",
      "Conta ou loja;Mercado Livre;Conta ML",
      "Soma do marketplace;Shopee;",
      "Conta ou loja;Shopee;Loja de teste",
      "Conta ou loja;Shopee;Loja Real",
      "Conta ou loja;Shopee;Loja Nova",
    ]);
    expect(corpo[0]).toBe("Total;Todos os marketplaces;;;1500,75;0;10;12;100;;;;;");
  });

  it("as palavras da tela: a loja de teste fora das somas, a nunca lida sem número, o recebido só da Shopee", () => {
    const corpo = linhas(contasParaCsv(resumo, "todos"));

    expect(corpo.find((l) => l.includes("Loja de teste"))).toMatch(/;Teste;.*;Teste — fora das somas$/u);
    expect(corpo.find((l) => l.includes("Loja Nova"))).toBe("Conta ou loja;Shopee;Loja Nova;Real;;0;;;;;;;;pedidos ainda não lidos");
    expect(corpo.find((l) => l.startsWith("Soma do marketplace;Shopee"))).toBe("Soma do marketplace;Shopee;;;500,75;0;10;12;100;;400;1;;");
  });

  it("no recorte Shopee, sem o total; marketplace sem nada somável fica, e diz por quê", () => {
    const corpo = linhas(
      contasParaCsv(
        [linha({ nivel: "CONTA", marketplace: "SHOPEE", account_id: "s-teste", account_name: "Loja de teste", environment: "sandbox" })],
        "shopee",
      ),
    ).slice(1);

    expect(corpo[0]).toBe("Soma do marketplace;Shopee;;;;;;;;;;;;nada somável: só loja de teste ou ainda não lida");
    expect(corpo[0]?.split(";")).toHaveLength(14);
    expect(corpo.some((l) => l.startsWith("Total;"))).toBe(false);
  });
});

describe("diasDoMlParaCsv (D-602)", () => {
  it("um dia por linha, em ordem, com as palavras da tela do ML; compras sob marca é vazia, nunca zero", () => {
    const csv = diasDoMlParaCsv([
      { metric_date: "2026-10-15", gross_revenue: 1234.5, orders_count: 12, purchases_count: null, units_sold: 15 },
      { metric_date: "2026-10-14", gross_revenue: 900, orders_count: 9, purchases_count: 8, units_sold: 10 },
    ]);

    expect(linhas(csv)).toEqual([
      "Dia;Faturamento (receita bruta);Pedidos;Compras (packs);Unidades",
      "14/10/2026;900;9;8;10",
      "15/10/2026;1234,5;12;;15",
    ]);
  });
});

describe("hrefDaExportacao", () => {
  it("o endereço da tela com o caminho do CSV e a tabela: o mesmo recorte", () => {
    expect(hrefDaExportacao("/vendas?days=7&contas=a,b&metric=unidades", "dia")).toBe(
      "/vendas/exportar?days=7&contas=a%2Cb&metric=unidades&tabela=dia",
    );
    // O "Todos" é o padrão da tela e não vai na URL; o da exportação também não.
    expect(hrefDaExportacao("/vendas", "conta")).toBe("/vendas/exportar?tabela=conta");
    expect(hrefDaExportacao("/vendas?marketplace=shopee", "conta")).toBe("/vendas/exportar?marketplace=shopee&tabela=conta");
  });
});
