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
  montarCascataShopee,
  skuParaALista,
  type ComposicaoShopee,
  type SkuShopee,
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
  ajustes_cobertos: null,
  investimento_ads: null,
  ads_rateado: null,
  resultado_contribuicao: null,
  margem_contribuicao: null,
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
  ajustes_cobertos: 0,
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
      // Sem o lucro do ML calculado e sem a coluna da Shopee (antes da D-487): "—" dos dois lados, nunca zero.
      ["Lucro após imposto e Ads", null, null],
    ]);
    expect(linhas.every((l) => !("total" in l))).toBe(true);
  });

  it("D-485: o resultado da Shopee inclui os ajustes depois do repasse", () => {
    const resultado = linhasDaComparacao({ resumo, imposto }, TOTAL).find((l) => l.rotulo === "Resultado da venda");

    expect(resultado?.definicao?.shopee).toBe("recebido + ajustes depois do repasse − custo, pela conta da Shopee");
  });

  it("D-487: o lucro após imposto e Ads de cada lado, com a premissa do rateio e o Ads CPC da loja na Shopee", () => {
    const lucro = linhasDaComparacao({ resumo, imposto }, { ...TOTAL, resultado_contribuicao: 65 }, 210).find(
      (l) => l.rotulo === "Lucro após imposto e Ads",
    );

    expect([lucro?.ml, lucro?.shopee, lucro?.formato]).toEqual([210, 65, "moeda"]);
    expect(lucro?.definicao?.ml).toMatch(/rateado pela receita coberta/u);
    expect(lucro?.definicao?.shopee).toMatch(/Ads CPC da loja.*GMV Max fica fora/u);
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

describe("montarCascataShopee (D-452, sobre o C-61)", () => {
  /** O TOTAL da composição: 1.000 de receita coberta, 800 recebidos. */
  const composicao: ComposicaoShopee = {
    nivel: "TOTAL",
    account_id: null,
    account_name: null,
    environment: null,
    pedidos_cobertos: 10,
    receita_coberta: 1000,
    comissao: 120,
    taxa_servico: 40,
    taxa_transacao: 20,
    frete_loja: 30,
    frete_devolucao: null,
    cupom_loja: 0,
    afiliados: 10,
    taxa_por_pedido: null,
    protecao_envio: null,
    // Crédito: a Shopee repassou mais do que os componentes explicam.
    outros: -20,
    recebido_coberto: 800,
    comissao_liquida: null,
    taxa_servico_liquida: null,
    cupom_shopee: 15,
    moedas_shopee: null,
    desconto_shopee: null,
    pedidos_com_ajuste: 0,
    ajustes: null,
  };

  it("da receita ao resultado, componente a componente: o último degrau antes do recebido termina nele", () => {
    const cascata = montarCascataShopee(composicao, 500, 300, 0);

    expect(cascata?.degraus.map((d) => d.chave)).toEqual([
      "receita",
      "comissao",
      "taxa_servico",
      "taxa_transacao",
      "frete_loja",
      "afiliados",
      "outros",
      "recebido",
      "custo",
      "resultado",
    ]);

    // 1 − 0,12 − 0,04 − 0,02 − 0,03 − 0,01 + 0,02 = 0,80: a identidade do banco, sem conta aqui.
    const outros = cascata?.degraus.find((d) => d.chave === "outros");

    expect(outros?.inicio).toBeCloseTo(0.78);
    expect((outros?.inicio ?? 0) + (outros?.largura ?? 0)).toBeCloseTo(0.8);
    expect(cascata?.degraus.find((d) => d.chave === "recebido")?.fracao).toBeCloseTo(0.8);
  });

  it("o crédito sobe: 'outros' negativo vira valor positivo, e o desconto fica negativo", () => {
    const cascata = montarCascataShopee(composicao, 500, 300, 0);

    expect(cascata?.degraus.find((d) => d.chave === "outros")?.valor).toBe(20);
    expect(cascata?.degraus.find((d) => d.chave === "comissao")?.valor).toBe(-120);
  });

  it("componente nulo fica fora e é dito; o zerado também sai das barras e é dito à parte", () => {
    const cascata = montarCascataShopee(composicao, 500, 300, 0);

    expect(cascata?.naoInformados).toEqual(["Frete de devolução", "Taxa por pedido", "Proteção de envio"]);
    expect(cascata?.zerados).toEqual(["Cupons da loja", "Ajustes depois do repasse"]);
  });

  it("sem cobertura, sem recebido, sem custo ou sem resultado não há cascata -- nunca uma de zeros", () => {
    expect(montarCascataShopee(null, 500, 300, 0)).toBeNull();
    expect(montarCascataShopee({ ...composicao, pedidos_cobertos: 0 }, 500, 300, 0)).toBeNull();
    expect(montarCascataShopee({ ...composicao, recebido_coberto: null }, 500, 300, 0)).toBeNull();
    expect(montarCascataShopee(composicao, null, 300, 0)).toBeNull();
    expect(montarCascataShopee(composicao, 500, null, 0)).toBeNull();
  });

});

describe("montarCascataShopee com a proteção de envio (D-483, D-492)", () => {
  /**
   * O contrato de hoje (fase 2 da D-483, em produção desde 16/10): 1.000 de
   * receita coberta, 800 recebidos, 195 dos componentes de sempre e 5 da
   * proteção de envio -- o `outros` já é o restante, zero como na leitura real.
   */
  const composicao: ComposicaoShopee = {
    nivel: "TOTAL",
    account_id: null,
    account_name: null,
    environment: null,
    pedidos_cobertos: 10,
    receita_coberta: 1000,
    comissao: 120,
    taxa_servico: 40,
    taxa_transacao: 20,
    frete_loja: 15,
    frete_devolucao: null,
    cupom_loja: null,
    afiliados: null,
    taxa_por_pedido: null,
    protecao_envio: 5,
    outros: 0,
    recebido_coberto: 800,
    comissao_liquida: null,
    taxa_servico_liquida: null,
    cupom_shopee: null,
    moedas_shopee: null,
    desconto_shopee: null,
    pedidos_com_ajuste: 0,
    ajustes: null,
  };

  it("a proteção de envio tem degrau próprio, antes de 'Outros', e termina no recebido", () => {
    const cascata = montarCascataShopee(composicao, 500, 300, 0);

    expect(cascata?.degraus.map((d) => d.chave)).toEqual([
      "receita",
      "comissao",
      "taxa_servico",
      "taxa_transacao",
      "frete_loja",
      "protecao_envio",
      "recebido",
      "custo",
      "resultado",
    ]);

    // 1 − 0,12 − 0,04 − 0,02 − 0,015 − 0,005 = 0,80: a proteção termina no recebido.
    const protecao = cascata?.degraus.find((d) => d.chave === "protecao_envio");

    expect(protecao?.rotulo).toBe("Proteção de envio");
    expect(protecao?.valor).toBe(-5);
    expect(protecao?.inicio).toBeCloseTo(0.8);
    expect((protecao?.inicio ?? 0) + (protecao?.largura ?? 0)).toBeCloseTo(0.805);
    // O restante zero sai das barras e é dito.
    expect(cascata?.zerados).toEqual(["Outros (fecha com o recebido)", "Ajustes depois do repasse"]);
  });

  it("o outros que sobra é o do banco, ao lado da proteção -- e um crédito sobe", () => {
    const cascata = montarCascataShopee({ ...composicao, outros: -20 }, 500, 300, 0);

    expect(cascata?.degraus.find((d) => d.chave === "protecao_envio")?.valor).toBe(-5);
    expect(cascata?.degraus.find((d) => d.chave === "outros")?.valor).toBe(20);
  });

  it("loja sem o campo: a proteção é nula e dita, e o outros fecha a conta", () => {
    const cascata = montarCascataShopee({ ...composicao, protecao_envio: null, outros: 5 }, 500, 300, 0);

    expect(cascata?.naoInformados).toContain("Proteção de envio");
    expect(cascata?.degraus.find((d) => d.chave === "outros")?.valor).toBe(-5);
  });

});

describe("montarCascataShopee com os ajustes depois do repasse (D-485, D-498)", () => {
  /** 1.000 de receita coberta, 200 de comissão, 800 recebidos; o custo é 500. */
  const composicao: ComposicaoShopee = {
    nivel: "TOTAL",
    account_id: null,
    account_name: null,
    environment: null,
    pedidos_cobertos: 10,
    receita_coberta: 1000,
    comissao: 200,
    taxa_servico: null,
    taxa_transacao: null,
    frete_loja: null,
    frete_devolucao: null,
    cupom_loja: null,
    afiliados: null,
    taxa_por_pedido: null,
    protecao_envio: 0,
    outros: 0,
    recebido_coberto: 800,
    comissao_liquida: null,
    taxa_servico_liquida: null,
    cupom_shopee: null,
    moedas_shopee: null,
    desconto_shopee: null,
    pedidos_com_ajuste: 0,
    ajustes: null,
  };
  const degrau = (cascata: ReturnType<typeof montarCascataShopee>, chave: string) => cascata?.degraus.find((d) => d.chave === chave);
  const fim = (d: ReturnType<typeof degrau>): number => (d?.inicio ?? 0) + (d?.largura ?? 0);

  it("o ajuste cobrado é degrau entre o recebido e o custo, e o custo começa onde ele termina", () => {
    // O SQL já fecha: 800 − 10 − 500 = 290.
    const cascata = montarCascataShopee(composicao, 500, 290, -10);

    expect(cascata?.degraus.map((d) => d.chave)).toEqual(["receita", "comissao", "recebido", "ajustes", "custo", "resultado"]);

    const ajustes = degrau(cascata, "ajustes");

    expect([ajustes?.rotulo, ajustes?.metricId, ajustes?.valor]).toEqual(["Ajustes depois do repasse", "shopee_ajustes_pos_repasse", -10]);
    expect(ajustes?.inicio).toBeCloseTo(0.79);
    expect(fim(ajustes)).toBeCloseTo(0.8);
    expect(degrau(cascata, "custo")?.inicio).toBeCloseTo(0.29);
    expect(fim(degrau(cascata, "custo"))).toBeCloseTo(0.79);
  });

  it("um ajuste a favor da loja sobe, e o custo começa acima do recebido", () => {
    const cascata = montarCascataShopee(composicao, 500, 310, 10);

    expect(degrau(cascata, "ajustes")?.valor).toBe(10);
    expect(fim(degrau(cascata, "ajustes"))).toBeCloseTo(0.81);
    expect(fim(degrau(cascata, "custo"))).toBeCloseTo(0.81);
  });

  it("zero vai para 'sem valor'; nulo (nenhum coberto trouxe o campo) é dito -- e o custo segue do recebido", () => {
    const zero = montarCascataShopee(composicao, 500, 300, 0);
    const nulo = montarCascataShopee(composicao, 500, 300, null);

    expect(zero?.zerados).toContain("Ajustes depois do repasse");
    expect(nulo?.naoInformados).toContain("Ajustes depois do repasse");

    for (const cascata of [zero, nulo]) {
      expect(degrau(cascata, "ajustes")).toBeUndefined();
      expect(fim(degrau(cascata, "custo"))).toBeCloseTo(0.8);
    }
  });
});

describe("skuParaALista", () => {
  const sku: SkuShopee = {
    sku_id: "s-1",
    sku: "ABC",
    title: "Capacete",
    custo_atual: false,
    unidades: 3,
    pedidos: 3,
    receita_bruta: 300,
    pedidos_cobertos: 2,
    receita_coberta: 200,
    recebido_coberto: 160,
    custo_produtos: 100,
    resultado_venda: 60,
    margem_venda: 0.3,
    pedidos_varios_skus: 1,
    receita_varios_skus: 90,
    total_count: 1,
  };

  it("muda de nome para a lista do Faturamento: comissão e frete do ML ficam nulos", () => {
    expect(skuParaALista(sku)).toMatchObject({ sku_id: "s-1", receita_bruta: 300, taxas_ml: null, frete_vendedor: null, margem_venda: 0.3 });
  });

  it("receita desconhecida não vira zero: o SKU sai da lista", () => {
    expect(skuParaALista({ ...sku, receita_bruta: null })).toBeNull();
  });
});
