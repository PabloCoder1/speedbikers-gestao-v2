import { describe, expect, it } from "vitest";

import type { ImpostoDoPeriodo, ResumoFaturamento } from "./faturamento";
import {
  hrefDeFaturamento,
  linhasDaComparacao,
  lojaDeTeste,
  lojaNuncaLida,
  motivosForaDaCobertura,
  separarLinhasShopee,
  type LinhaFaturamentoShopee,
  type RecorteDeFaturamento,
} from "./faturamento-multicanal";
import type { ContaDoSeletor } from "./vendas-multicanal";

const ML: ContaDoSeletor = { account_id: "ml-1", marketplace: "ML", name: "Loja E2E", environment: "live" };
const LOJA: ContaDoSeletor = { account_id: "sp-1", marketplace: "SHOPEE", name: "Speedbikers", environment: "live" };
const TESTE: ContaDoSeletor = { account_id: "sp-2", marketplace: "SHOPEE", name: "Loja de teste", environment: "sandbox" };

const NULA: LinhaFaturamentoShopee = {
  nivel: "CONTA",
  account_id: "sp-2",
  account_name: "Loja de teste",
  environment: "sandbox",
  pedidos: null,
  receita_bruta: null,
  pedidos_sem_receita: null,
  pedidos_cobertos: null,
  receita_coberta: null,
  recebido_coberto: null,
  custo_produtos: null,
  resultado_venda: null,
  margem_venda: null,
  pedidos_definitivos: null,
  resultado_definitivo: null,
  pedidos_provisorios: null,
  resultado_provisorio: null,
  pedidos_sem_financeiro: null,
  pedidos_sem_sku: null,
  pedidos_sem_custo: null,
  pedidos_custo_atual: null,
  pedidos_sem_aliquota: null,
  imposto_coberto: null,
  resultado_apos_imposto: null,
  margem_apos_imposto: null,
  ultima_atualizacao: null,
};

const TOTAL: LinhaFaturamentoShopee = {
  ...NULA,
  nivel: "TOTAL",
  account_id: null,
  account_name: null,
  environment: null,
  pedidos: 10,
  receita_bruta: 1000,
  pedidos_sem_receita: 1,
  pedidos_cobertos: 6,
  receita_coberta: 600,
  recebido_coberto: 480,
  custo_produtos: 300,
  resultado_venda: 180,
  margem_venda: 0.3,
  pedidos_sem_financeiro: 2,
  pedidos_sem_sku: 2,
  pedidos_sem_custo: 0,
  resultado_apos_imposto: 120,
};

const LIVE: LinhaFaturamentoShopee = { ...TOTAL, nivel: "CONTA", account_id: "sp-1", account_name: "Speedbikers", environment: "live" };

describe("hrefDeFaturamento", () => {
  const shopee: RecorteDeFaturamento = { escopo: "shopee", periodo: { days: 7 }, contas: [LOJA] };

  it("a Shopee guarda as lojas num valor só, com os nomes de parâmetro de /vendas", () => {
    expect(hrefDeFaturamento(shopee)).toBe("/faturamento?marketplace=shopee&days=7&contas=sp-1");
    expect(hrefDeFaturamento(shopee, { contas: [LOJA, TESTE] })).toBe(
      "/faturamento?marketplace=shopee&days=7&contas=sp-1%2Csp-2",
    );
  });

  it("no Todos as lojas caem: o lado do Mercado Livre aceita uma conta só", () => {
    expect(hrefDeFaturamento(shopee, { escopo: "todos" })).toBe("/faturamento?marketplace=todos&days=7");
    expect(hrefDeFaturamento({ escopo: "todos", periodo: { days: 7 }, contas: [ML] })).toBe(
      "/faturamento?marketplace=todos&days=7",
    );
  });

  it("a tela do ML leva só o período, e o período padrão fica fora da URL", () => {
    expect(hrefDeFaturamento(shopee, { escopo: "ml" })).toBe("/faturamento?days=7");
    expect(hrefDeFaturamento(shopee, { escopo: "ml", periodo: { days: 30 } })).toBe("/faturamento");
    expect(hrefDeFaturamento(shopee, { periodo: { from: "2026-10-01", to: "2026-10-10" } })).toBe(
      "/faturamento?marketplace=shopee&from=2026-10-01&to=2026-10-10&contas=sp-1",
    );
  });

  it("uma conta do ML num link Shopee não sobrevive", () => {
    expect(hrefDeFaturamento({ ...shopee, contas: [ML, LOJA] })).toBe("/faturamento?marketplace=shopee&days=7&contas=sp-1");
  });
});

describe("separarLinhasShopee", () => {
  it("o TOTAL à parte e as lojas na ordem do contrato", () => {
    expect(separarLinhasShopee([TOTAL, LIVE, NULA])).toEqual({ total: TOTAL, lojas: [LIVE, NULA] });
  });

  it("sem loja live lida não há TOTAL — e isso não é zero", () => {
    expect(separarLinhasShopee([NULA])).toEqual({ total: null, lojas: [NULA] });
  });

  it("a loja de teste e a nunca lida são reconhecidas pela linha", () => {
    expect(lojaDeTeste(NULA)).toBe(true);
    expect(lojaNuncaLida(NULA)).toBe(true);
    expect(lojaDeTeste(LIVE)).toBe(false);
    expect(lojaNuncaLida(LIVE)).toBe(false);
  });
});

describe("motivosForaDaCobertura", () => {
  it("os quatro motivos do contrato, na ordem em que o pedido avança", () => {
    expect(motivosForaDaCobertura(TOTAL).map((m) => [m.chave, m.pedidos])).toEqual([
      ["sem_receita", 1],
      ["sem_financeiro", 2],
      ["sem_sku", 2],
      ["sem_custo", 0],
    ]);
  });

  it("o vínculo da Shopee se resolve na tela de anúncios da Shopee", () => {
    expect(motivosForaDaCobertura(TOTAL).find((m) => m.chave === "sem_sku")?.link?.href).toBe("/anuncios/shopee");
  });
});

describe("linhasDaComparacao", () => {
  const resumo = {
    receita_bruta: 2000,
    compras: 15,
    receita_coberta: 1500,
    margem_operacional_coberta: 1100,
    custo_produtos: 700,
    resultado_venda: 400,
    margem_venda: 0.2667,
  } as ResumoFaturamento;
  const imposto = { resultado_apos_imposto: 250 } as ImpostoDoPeriodo;

  it("cada lado lê o seu contrato; nenhuma linha traz total", () => {
    const linhas = linhasDaComparacao({ resumo, imposto }, TOTAL);

    expect(linhas.map((l) => [l.rotulo, l.ml, l.shopee])).toEqual([
      ["Receita bruta", 2000, 1000],
      ["Compras", 15, 10],
      ["Receita coberta", 1500, 600],
      ["Recebido", 1100, 480],
      ["Custo dos produtos", 700, 300],
      ["Resultado da venda", 400, 180],
      ["Margem sobre a venda", 0.2667, 0.3],
      ["Resultado após imposto", 250, 120],
    ]);
    expect(linhas.every((l) => !("total" in l))).toBe(true);
  });

  it("o recebido diz o que cada canal desconta: as definições não são a mesma", () => {
    const recebido = linhasDaComparacao({ resumo, imposto }, TOTAL).find((l) => l.rotulo === "Recebido");

    expect(recebido?.definicao?.ml).toMatch(/taxa fixa/);
    expect(recebido?.definicao?.shopee).toMatch(/escrow/);
  });

  it("um lado ausente é nulo, nunca zero; sem imposto no ML, o após imposto é nulo", () => {
    const semShopee = linhasDaComparacao({ resumo, imposto: null }, null);

    expect(semShopee.every((l) => l.shopee === null)).toBe(true);
    expect(semShopee.find((l) => l.rotulo === "Resultado após imposto")?.ml).toBeNull();
    expect(linhasDaComparacao(null, TOTAL).every((l) => l.ml === null)).toBe(true);
  });
});
