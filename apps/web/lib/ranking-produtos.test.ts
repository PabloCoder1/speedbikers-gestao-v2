import { describe, expect, it } from "vitest";

import {
  formatPontos,
  formatVariacao,
  frasesDoRanking,
  lerRankingProdutos,
  ordemDaUrl,
  paginaDaUrl,
  valorDaOrdem,
  type ResumoDoRanking,
} from "./ranking-produtos";

function limpo(texto: string): string {
  return texto.replaceAll(String.fromCharCode(160), " ");
}

const ITEM = {
  sku_id: "11111111-0000-4000-8000-000000000001",
  sku: "RK-D",
  title: "Produto D",
  unidades: 20,
  pedidos: 10,
  receita_bruta: 800,
  taxas_ml: 80,
  pedidos_cobertos: 10,
  receita_coberta: 800,
  taxas_ml_cobertas: 80,
  frete_vendedor: 120,
  custo_produtos: 400,
  resultado_venda: 200,
  margem_venda: 0.25,
  imposto: null,
  resultado_apos_imposto: null,
  margem_apos_imposto: null,
  custo_atual: true,
  pedidos_anterior: 5,
  unidades_anterior: 10,
  receita_anterior: 400,
  pedidos_cobertos_anterior: 5,
  resultado_anterior: 100,
  margem_anterior: 0.25,
  variacao_receita: 1,
  variacao_margem: 0,
  frete_sobre_receita: 0.15,
};

/** Os números do teste de integração de D-402, como a RPC os devolve. */
const RESPOSTA = {
  periodo: { inicio: "2023-03-11", fim: "2023-03-20", anterior_inicio: "2023-03-01", anterior_fim: "2023-03-10" },
  ordem: "receita",
  resumo: {
    skus_com_venda: 4,
    receita_bruta: 2520,
    receita_bruta_anterior: 1400,
    skus_cobertos: 4,
    resultado_venda: 1078,
    skus_prejuizo: 1,
    prejuizo: -50,
    skus_margem_abaixo_10: 1,
    skus_comparaveis: 3,
    skus_crescendo: 1,
    skus_margem_comparavel: 3,
    skus_queda_margem: 1,
    skus_metade_do_resultado: 2,
  },
  total: 4,
  itens: [ITEM],
};

describe("lerRankingProdutos", () => {
  it("lê a resposta da RPC", () => {
    const r = lerRankingProdutos(RESPOSTA);

    expect(r?.ordem).toBe("receita");
    expect(r?.total).toBe(4);
    expect(r?.itens[0]).toMatchObject({ sku: "RK-D", receita_bruta: 800, variacao_receita: 1, custo_atual: true });
    expect(r?.resumo.skus_metade_do_resultado).toBe(2);
  });

  it("comissão ausente (pedido sem sale_fee) é NULL, não zero, e não recusa a resposta", () => {
    const r = lerRankingProdutos({ ...RESPOSTA, itens: [{ ...ITEM, taxas_ml: null }] });

    expect(r?.itens[0]?.taxas_ml).toBeNull();
  });

  it("recusa campo que falta, ordem desconhecida e número que não é número — nunca vira zero", () => {
    const semMargem: Record<string, unknown> = { ...ITEM };

    delete semMargem.margem_venda;

    expect(lerRankingProdutos({ ...RESPOSTA, itens: [semMargem] })).toBeNull();
    expect(lerRankingProdutos({ ...RESPOSTA, ordem: "ads" })).toBeNull();
    expect(lerRankingProdutos({ ...RESPOSTA, resumo: { ...RESPOSTA.resumo, skus_prejuizo: "muitos" } })).toBeNull();
    expect(lerRankingProdutos({ ...RESPOSTA, resumo: { ...RESPOSTA.resumo, skus_prejuizo: null } })).toBeNull();
    expect(lerRankingProdutos(null)).toBeNull();
  });
});

describe("a URL", () => {
  it("ordem desconhecida cai no faturamento; página inválida, na primeira", () => {
    expect(ordemDaUrl("prejuizo")).toBe("prejuizo");
    expect(ordemDaUrl("ads")).toBe("receita");
    expect(ordemDaUrl(undefined)).toBe("receita");
    expect(paginaDaUrl("3")).toBe(3);
    expect(paginaDaUrl("0")).toBe(1);
    expect(paginaDaUrl("-2")).toBe(1);
    expect(paginaDaUrl(["2"])).toBe(1);
  });
});

describe("frasesDoRanking", () => {
  it("prejuízo, queda de margem, concentração e crescimento, com os números", () => {
    const frases = frasesDoRanking(RESPOSTA.resumo).map((f) => [f.ordem, limpo(f.texto)]);

    expect(frases).toEqual([
      ["prejuizo", "1 produto vendeu com prejuízo: -R$ 50,00 de resultado somado."],
      ["queda_margem", "1 produto perdeu 5 p.p. de margem ou mais contra o período anterior (de 3 comparáveis)."],
      ["lucro", "2 produtos fazem metade dos R$ 1.078,00 de resultado das vendas — 50,0% dos 4 vendidos."],
      ["crescimento", "1 produto cresceu 30% ou mais em receita, de 3 comparáveis; a receita de todos os produtos variou +80%."],
    ]);
  });

  it("contagem zero e número ausente não viram frase", () => {
    const vazio: ResumoDoRanking = {
      ...RESPOSTA.resumo,
      skus_prejuizo: 0,
      prejuizo: null,
      skus_queda_margem: 0,
      skus_metade_do_resultado: null,
      skus_crescendo: 0,
    };

    expect(frasesDoRanking(vazio)).toEqual([]);
  });

  it("sem receita anterior, o crescimento sai sem a comparação geral", () => {
    const [frase] = frasesDoRanking({
      ...RESPOSTA.resumo,
      skus_prejuizo: 0,
      skus_queda_margem: 0,
      skus_metade_do_resultado: null,
      receita_bruta_anterior: null,
    });

    expect(limpo(frase?.texto ?? "")).toBe("1 produto cresceu 30% ou mais em receita, de 3 comparáveis.");
  });
});

describe("formatos", () => {
  it("variação com sinal, zero sem sinal, ausente como traço", () => {
    expect(formatVariacao(0.2)).toBe("+20%");
    expect(formatVariacao(-0.354)).toBe("−35%");
    expect(formatVariacao(0.001)).toBe("0%");
    expect(formatVariacao(null)).toBe("—");
    expect(limpo(formatPontos(-0.4))).toBe("−40,0 p.p.");
    expect(limpo(formatPontos(0))).toBe("0,0 p.p.");
  });

  it("o valor da coluna de cada ordem", () => {
    const item = lerRankingProdutos(RESPOSTA)?.itens[0];

    if (item === undefined) throw new Error("fixture fora do contrato");

    expect(limpo(valorDaOrdem("receita", item))).toBe("R$ 800,00");
    expect(valorDaOrdem("margem", item)).toBe("25,0%");
    expect(valorDaOrdem("volume", item)).toBe("20");
    expect(valorDaOrdem("crescimento", item)).toBe("+100%");
    expect(limpo(valorDaOrdem("queda_margem", item))).toBe("0,0 p.p.");
  });
});
