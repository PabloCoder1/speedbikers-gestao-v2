import { describe, expect, it } from "vitest";

import type { ResumoAds } from "./ads";
import {
  coberturaDoAds,
  decomporMargem,
  montarIndicadores,
  montarResumo,
  type EntradaCentral,
  type Indicador,
  type ResumoCentral,
} from "./central-indicadores";
import type { ImpostoDoPeriodo, ResumoFaturamento } from "./faturamento";

/**
 * Um período com cobertura total: 100 pedidos, todos cobertos. Receita 10.000,
 * comissão 1.000, frete 1.500, custo 5.000 → margem 25%.
 */
function resumo(parcial: Partial<ResumoFaturamento> = {}): ResumoFaturamento {
  const base: ResumoFaturamento = {
    pedidos: 100,
    compras: 95,
    unidades: 120,
    receita_bruta: 10_000,
    taxas_ml: 1_000,
    ticket_medio: 105.26,
    preco_medio: 83.33,
    comissao_percentual: 0.1,
    pedidos_com_custos: 100,
    receita_com_custos: 10_000,
    taxas_ml_com_custos: 1_000,
    frete_vendedor: 1_500,
    desconto_vendedor: 0,
    margem_operacional: 7_500,
    frete_medio_pedido: 15,
    pedidos_cobertos: 100,
    receita_coberta: 10_000,
    taxas_ml_cobertas: 1_000,
    frete_vendedor_coberto: 1_500,
    margem_operacional_coberta: 7_500,
    custo_produtos: 5_000,
    resultado_venda: 2_500,
    margem_venda: 0.25,
    pedidos_custo_atual: 0,
    pedidos_sem_sku: 0,
    pedidos_sem_custo: 0,
    pedidos_sem_frete: 0,
    pedidos_multi_item: 0,
  };

  return { ...base, ...parcial };
}

function ads(parcial: Partial<ResumoAds> = {}): ResumoAds {
  return {
    investimento: 500,
    receita_ads: 2_500,
    receita_direta: 2_000,
    receita_indireta: 500,
    cliques: 1_000,
    impressoes: 50_000,
    unidades: 30,
    campanhas_com_metrica: 3,
    acos: 0.2,
    roas: 5,
    ctr: 0.02,
    cpc: 0.5,
    receita_bruta: 10_000,
    tacos: 0.05,
    ...parcial,
  };
}

const COMPLETA = { completa: true, ate: "2026-09-22" };

/** 6% sobre a receita do fixture: 600 de imposto, resultado 2.500 − 600 = 1.900, margem 19%. */
function imposto(parcial: Partial<ImpostoDoPeriodo> = {}): ImpostoDoPeriodo {
  return {
    pedidos_sem_aliquota: 0,
    aliquota_unica: 0.06,
    imposto_estimado: 600,
    imposto_coberto: 600,
    resultado_apos_imposto: 1_900,
    margem_apos_imposto: 0.19,
    ...parcial,
  };
}

const SEM_ALIQUOTA = imposto({
  pedidos_sem_aliquota: 100,
  aliquota_unica: null,
  imposto_estimado: null,
  imposto_coberto: null,
  resultado_apos_imposto: null,
  margem_apos_imposto: null,
});

function entrada(parcial: Partial<EntradaCentral> = {}): EntradaCentral {
  return {
    atual: resumo(),
    anterior: resumo(),
    adsAtual: ads(),
    adsAnterior: ads(),
    coberturaAdsAtual: COMPLETA,
    coberturaAdsAnterior: COMPLETA,
    emAndamento: false,
    impostoAtual: null,
    impostoAnterior: null,
    adsZeroLegitimo: false,
    ...parcial,
  };
}

function indicador(lista: readonly Indicador[], id: string): Indicador {
  const achado = lista.find((i) => i.id === id);

  if (achado === undefined) throw new Error(`indicador ${id} ausente`);

  return achado;
}

describe("montarIndicadores", () => {
  it("compara comissão e custo pela participação na receita, não pelo valor em reais", () => {
    // Receita +20% e comissão +20%: a comissão em reais subiu, a participação não.
    const lista = montarIndicadores(
      entrada({ atual: resumo({ receita_bruta: 12_000, taxas_ml: 1_200, comissao_percentual: 0.1 }) }),
    );
    const comissao = indicador(lista, "comissao");

    expect(comissao.valor).toBe(1_200);
    expect(comissao.comparado.escala).toBe("fracao");
    expect(comissao.variacao?.relevante).toBe(false);
    expect(comissao.variacao?.tom).toBe("neutro");
  });

  it("frete médio que sobe 20% é perigo; ticket que sobe é bom", () => {
    const lista = montarIndicadores(entrada({ atual: resumo({ frete_medio_pedido: 18, ticket_medio: 120 }) }));

    expect(indicador(lista, "frete").variacao?.tom).toBe("perigo");
    expect(indicador(lista, "ticket").variacao?.tom).toBe("ok");
  });

  it("recusa comparar resultado em reais com coberturas muito diferentes, mas compara a margem", () => {
    const lista = montarIndicadores(
      entrada({
        atual: resumo({ receita_coberta: 3_000, taxas_ml_cobertas: 300, frete_vendedor_coberto: 450, custo_produtos: 1_500, resultado_venda: 750, pedidos_cobertos: 30 }),
      }),
    );
    const resultado = indicador(lista, "resultado");

    expect(resultado.variacao).toBeNull();
    expect(resultado.semComparacao).toContain("cobertura diferente");
    expect(indicador(lista, "margem").variacao).not.toBeNull();
  });

  it("recusa comparar margem com amostra pequena", () => {
    const lista = montarIndicadores(entrada({ atual: resumo({ pedidos_cobertos: 8 }) }));

    expect(indicador(lista, "margem").variacao).toBeNull();
    expect(indicador(lista, "margem").semComparacao).toContain("menos de 20 pedidos cobertos");
  });

  it("dia em andamento: volume sem julgamento, razões julgadas", () => {
    const lista = montarIndicadores(
      entrada({ emAndamento: true, atual: resumo({ receita_bruta: 3_000, pedidos: 30, ticket_medio: 80 }) }),
    );

    expect(indicador(lista, "receita").variacao?.tom).toBe("neutro");
    expect(indicador(lista, "pedidos").variacao?.tom).toBe("neutro");
    expect(indicador(lista, "ticket").variacao?.tom).toBe("perigo");
  });

  it("Ads sem o período inteiro no diário não compara, e diz até quando há dado", () => {
    const lista = montarIndicadores(entrada({ coberturaAdsAtual: { completa: false, ate: "2026-09-21" } }));
    const investimento = indicador(lista, "investimento");

    expect(investimento.variacao).toBeNull();
    expect(investimento.semComparacao).toContain("21/09/2026");
    expect(investimento.valor).toBe(500);
  });

  it("investimento em Ads nunca é julgado sozinho; TACoS que sobe é ruim", () => {
    const lista = montarIndicadores(entrada({ adsAtual: ads({ investimento: 1_000, tacos: 0.1 }) }));

    expect(indicador(lista, "investimento").variacao?.tom).toBe("neutro");
    expect(indicador(lista, "tacos").variacao?.tom).toBe("perigo");
  });

  it("período anterior que falhou não vira zero: toda comparação sai com o motivo", () => {
    const lista = montarIndicadores(entrada({ anterior: null }));

    expect(indicador(lista, "receita").variacao).toBeNull();
    expect(indicador(lista, "receita").semComparacao).toBe("o período anterior não carregou");
  });
});

describe("imposto e lucro após imposto e Ads (D-395)", () => {
  it("o Ads entra rateado pela receita coberta, e a margem de contribuição é margem após imposto − TACoS", () => {
    // Cobertura de 80%: dos 500 de Ads, 400 caem nos pedidos cobertos.
    const lista = montarIndicadores(
      entrada({ atual: resumo({ receita_bruta: 12_500 }), impostoAtual: imposto(), impostoAnterior: imposto() }),
    );

    expect(indicador(lista, "lucro").valor).toBe(1_500);
    expect(indicador(lista, "contribuicao").valor).toBeCloseTo(0.15);
    expect(indicador(lista, "imposto").ressalva).toBe("alíquota de 6% sobre o faturamento");
  });

  it("sem alíquota cadastrada: imposto e lucro em branco, com o caminho para cadastrar", () => {
    const lista = montarIndicadores(entrada({ impostoAtual: SEM_ALIQUOTA, impostoAnterior: SEM_ALIQUOTA }));

    expect(indicador(lista, "imposto").valor).toBeNull();
    expect(indicador(lista, "imposto").ressalva).toContain("cadastre em Metas e imposto");
    expect(indicador(lista, "lucro").valor).toBeNull();
  });

  it("banco sem o imposto de D-395: diz que ainda não é calculado, e não que falta alíquota", () => {
    const lista = montarIndicadores(entrada());

    expect(indicador(lista, "imposto").ressalva).toBe("o imposto ainda não é calculado neste ambiente");
  });

  it("Ads incompleto segura o lucro; sem conta com Product Ads, o zero é legítimo", () => {
    const incompleto = { completa: false, ate: "2026-09-21" };

    expect(
      indicador(montarIndicadores(entrada({ impostoAtual: imposto(), coberturaAdsAtual: incompleto })), "lucro").valor,
    ).toBeNull();

    const semAds = montarIndicadores(
      entrada({ impostoAtual: imposto(), adsAtual: null, coberturaAdsAtual: incompleto, adsZeroLegitimo: true }),
    );

    expect(indicador(semAds, "lucro").valor).toBe(1_900);
  });
});

describe("coberturaDoAds", () => {
  it("exige linha no primeiro e no último dia do período", () => {
    const diario = [
      { dia: "2026-09-01", investimento: 10, receita_ads: 50 },
      { dia: "2026-09-22", investimento: 10, receita_ads: 50 },
    ];

    expect(coberturaDoAds(diario, "2026-09-01", "2026-09-22")).toEqual({ completa: true, ate: "2026-09-22" });
    expect(coberturaDoAds(diario, "2026-09-01", "2026-09-23")).toEqual({ completa: false, ate: "2026-09-22" });
    expect(coberturaDoAds([], "2026-09-01", "2026-09-22")).toEqual({ completa: false, ate: null });
  });
});

describe("decomporMargem", () => {
  it("reparte a queda da margem exatamente entre comissão, frete e custo", () => {
    // Frete de 15% para 20% da receita e custo de 50% para 51%: margem 25% → 19%.
    const atual = resumo({ frete_vendedor_coberto: 2_000, custo_produtos: 5_100, resultado_venda: 1_900, margem_venda: 0.19 });
    const parcelas = decomporMargem(atual, resumo());

    expect(parcelas?.map((p) => [p.nome, Number(p.efeito.toFixed(4))])).toEqual([
      ["comissão", 0],
      ["frete", -0.05],
      ["custo dos produtos", -0.01],
    ]);
  });

  it("não atribui nada quando a identidade da margem não fecha", () => {
    expect(decomporMargem(resumo({ margem_venda: 0.3 }), resumo())).toBeNull();
    expect(decomporMargem(resumo({ custo_produtos: null }), resumo())).toBeNull();
  });
});

/** O `Intl` de moeda separa "R$" do número com espaço não separável; o teste compara texto legível. */
function texto(r: ResumoCentral): ResumoCentral {
  return { ...r, frases: r.frases.map((f) => f.replaceAll(String.fromCharCode(160), " ")) };
}

describe("montarResumo", () => {
  it("conta a história: faturamento em alta, resultado em queda e o que pesou na margem", () => {
    const e = entrada({
      // Receita +15%, frete de 15% para 20% da receita, custo de 50% para 51%.
      atual: resumo({
        receita_bruta: 11_500,
        receita_coberta: 11_500,
        taxas_ml_cobertas: 1_150,
        frete_vendedor_coberto: 2_300,
        custo_produtos: 5_865,
        resultado_venda: 2_185,
        margem_venda: 0.19,
      }),
    });
    const r = texto(montarResumo(montarIndicadores(e), e, "30d"));

    expect(r.frases[0]).toBe("Nos últimos 30 dias, o faturamento foi de R$ 11.500,00, alta de 15,0% sobre o período anterior.");
    expect(r.frases).toContain("O resultado da venda teve queda de 12,6%, mesmo com o faturamento em alta.");
    expect(r.frases).toContain(
      "A margem sobre a venda caiu de 25,0% para 19,0%. Pesaram: frete (−5,0 p.p.), custo dos produtos (−1,0 p.p.).",
    );
    expect(r.atencao[0]?.tom).toBe("perigo");
    expect(r.melhoras.map((s) => s.indicador)).toContain("receita");
  });

  it("não afirma margem quando não há pedido coberto", () => {
    const e = entrada({
      atual: resumo({
        pedidos_cobertos: 0,
        receita_coberta: null,
        taxas_ml_cobertas: null,
        frete_vendedor_coberto: null,
        custo_produtos: null,
        resultado_venda: null,
        margem_venda: null,
      }),
    });
    const r = texto(montarResumo(montarIndicadores(e), e, "7d"));

    expect(r.frases).toContain("Sem margem no período: nenhum pedido tem frete e custo observados ao mesmo tempo.");
    expect(r.frases.some((f) => f.startsWith("O resultado da venda"))).toBe(false);
  });

  it("com o dia em andamento não diz que o faturamento caiu", () => {
    const e = entrada({ emAndamento: true, atual: resumo({ receita_bruta: 3_000 }) });
    const r = texto(montarResumo(montarIndicadores(e), e, "hoje"));

    expect(r.frases[0]).toBe(
      "Hoje, com o dia em andamento, o faturamento soma R$ 3.000,00; o período de comparação inteiro teve R$ 10.000,00.",
    );
    expect(r.atencao.some((s) => s.indicador === "receita")).toBe(false);
  });

  it("diz também o que compensou, para as parcelas fecharem com a variação", () => {
    // Frete de 15% para 17% da receita (−2 p.p.), custo de 50% para 49% (+1 p.p.): margem 25% → 24%.
    const e = entrada({
      atual: resumo({ frete_vendedor_coberto: 1_700, custo_produtos: 4_900, resultado_venda: 2_400, margem_venda: 0.24 }),
    });
    const r = texto(montarResumo(montarIndicadores(e), e, "30d"));

    expect(r.frases).toContain(
      "A margem sobre a venda caiu de 25,0% para 24,0%. Pesou: frete (−2,0 p.p.). Compensou em parte: custo dos produtos (+1,0 p.p.).",
    );
  });

  it("depois do imposto e do Ads: a margem de contribuição contra a do período anterior", () => {
    const e = entrada({
      impostoAtual: imposto(),
      impostoAnterior: imposto({ resultado_apos_imposto: 2_000, margem_apos_imposto: 0.2 }),
    });
    const r = texto(montarResumo(montarIndicadores(e), e, "30d"));

    expect(r.frases).toContain("Depois do imposto (6%) e do Ads, a margem de contribuição foi de 14,0%, contra 15,0% no período anterior.");
  });

  it("sem alíquota, o resumo diz que o lucro após imposto não é calculado", () => {
    const e = entrada({ impostoAtual: SEM_ALIQUOTA });
    const r = texto(montarResumo(montarIndicadores(e), e, "30d"));

    expect(r.frases).toContain("Sem alíquota de imposto cadastrada para o período: o lucro após imposto e Ads não é calculado.");
  });

  it("saindo do zero não diz 'estável' nem inventa porcentagem", () => {
    const e = entrada({ atual: resumo({ receita_bruta: 500 }), anterior: resumo({ receita_bruta: 0 }) });
    const r = texto(montarResumo(montarIndicadores(e), e, "ontem"));

    expect(r.frases[0]).toBe("Ontem, o faturamento foi de R$ 500,00, alta sobre um período anterior zerado.");
  });

  it("Ads: investimento e ROAS lado a lado, e o TACoS entra quando sobe", () => {
    const e = entrada({ adsAtual: ads({ investimento: 800, receita_ads: 3_200, roas: 4, tacos: 0.08 }) });
    const r = texto(montarResumo(montarIndicadores(e), e, "30d"));

    expect(r.frases).toContain(
      "No Mercado Ads, o investimento teve alta de 60,0% e o ROAS foi de 5,00x para 4,00x. O Ads passou de 5,0% para 8,0% do faturamento.",
    );
  });
});
