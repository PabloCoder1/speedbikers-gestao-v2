import { describe, expect, it } from "vitest";

import {
  comoDigitado,
  descreverLimites,
  LIMITES_PADRAO,
  lerFormularioDosLimites,
  lerLimites,
  valoresDosLimites,
  type CampoDosLimites,
} from "./limites-central";
import { avaliarVariacao, LIMITES_DA_VARIACAO } from "./variacao";

/** A linha como o PostgREST devolve: `numeric` chega como número ou texto. */
const LINHA = {
  change_neutral: 0.03,
  change_strong: "0.15",
  points_neutral: 0.01,
  points_strong: 0.03,
  goal_delay_warning: 0.08,
  margin_after_ads_low: "0.12",
  min_orders_sample: 30,
};

function formulario(valores: Partial<Record<CampoDosLimites, string>>): (nome: CampoDosLimites) => string {
  const base: Record<CampoDosLimites, string> = {
    change_neutral: "2",
    change_strong: "10",
    points_neutral: "0,5",
    points_strong: "2",
    goal_delay_warning: "5",
    margin_after_ads_low: "10",
    min_orders_sample: "20",
  };

  return (nome) => valores[nome] ?? base[nome];
}

describe("lerLimites (D-408)", () => {
  it("sem linha, os padrões — os mesmos números que o código usava antes", () => {
    expect(lerLimites(null)).toBe(LIMITES_PADRAO);
    expect(LIMITES_PADRAO.variacao).toBe(LIMITES_DA_VARIACAO);
    expect(valoresDosLimites(LIMITES_PADRAO)).toEqual({
      change_neutral: 0.02,
      change_strong: 0.1,
      points_neutral: 0.005,
      points_strong: 0.02,
      goal_delay_warning: 0.05,
      margin_after_ads_low: 0.1,
      min_orders_sample: 20,
    });
  });

  it("a linha da organização vira os limites, com numeric em texto ou número", () => {
    expect(lerLimites(LINHA)).toEqual({
      variacao: { valor: { neutro: 0.03, forte: 0.15 }, fracao: { neutro: 0.01, forte: 0.03 } },
      atrasoDaMeta: 0.08,
      margemAposAdsBaixa: 0.12,
      amostraMinima: 30,
      personalizados: true,
    });
  });

  it("linha fora da forma volta aos padrões: julgar com o de antes é melhor que não julgar", () => {
    expect(lerLimites({ ...LINHA, change_strong: null })).toBe(LIMITES_PADRAO);
    expect(lerLimites({ ...LINHA, min_orders_sample: "muitos" })).toBe(LIMITES_PADRAO);
  });

  it("os cortes da organização mudam o tom: 7% de queda é atenção no padrão e perigo com forte de 5%", () => {
    const limites = lerLimites({ ...LINHA, change_neutral: 0.01, change_strong: 0.05 });

    expect(avaliarVariacao(93, 100, "maior-melhor", "valor")?.tom).toBe("atencao");
    expect(avaliarVariacao(93, 100, "maior-melhor", "valor", { limites: limites.variacao })?.tom).toBe("perigo");
    // 1,5% é estável no padrão (2%) e já conta com estável de 1%.
    expect(avaliarVariacao(101.5, 100, "maior-melhor", "valor")?.relevante).toBe(false);
    expect(avaliarVariacao(101.5, 100, "maior-melhor", "valor", { limites: limites.variacao })?.tom).toBe("ok");
  });
});

describe("lerFormularioDosLimites (D-408)", () => {
  it("lê porcentagens como a pessoa escreve e devolve frações", () => {
    const lido = lerFormularioDosLimites(formulario({ points_neutral: "0,25", change_strong: "12,5%" }));

    expect(lido).toEqual({
      ok: true,
      valores: {
        change_neutral: 0.02,
        change_strong: 0.125,
        points_neutral: 0.0025,
        points_strong: 0.02,
        goal_delay_warning: 0.05,
        margin_after_ads_low: 0.1,
        min_orders_sample: 20,
      },
    });
  });

  it("a margem depois do Ads aceita zero; as variações e o atraso, não", () => {
    expect(lerFormularioDosLimites(formulario({ margin_after_ads_low: "0" })).ok).toBe(true);

    const lido = lerFormularioDosLimites(formulario({ change_neutral: "0", goal_delay_warning: "0" }));

    expect(lido.ok).toBe(false);
    expect(lido.ok ? {} : lido.erros).toMatchObject({
      change_neutral: "A variação estável fica acima de 0% e até 100%.",
      goal_delay_warning: "O atraso da meta fica acima de 0% e até 99,99%.",
    });
  });

  it("forte precisa passar do estável, nos dois pares — a mesma regra do CHECK", () => {
    const lido = lerFormularioDosLimites(formulario({ change_neutral: "10", change_strong: "10", points_strong: "0,5" }));

    expect(lido.ok ? {} : lido.erros).toEqual({
      change_strong: "A variação forte precisa ser maior que a estável.",
      points_strong: "A variação forte em pontos precisa ser maior que a estável.",
    });
  });

  it("recusa texto, três casas, pontos acima de 20 e amostra fracionada ou fora de 1 a 1.000", () => {
    const lido = lerFormularioDosLimites(
      formulario({ change_neutral: "dois", change_strong: "10,125", points_strong: "25", min_orders_sample: "20,5" }),
    );

    expect(lido.ok ? {} : lido.erros).toEqual({
      change_neutral: "Escreva a variação estável em porcentagem, por exemplo 2 ou 0,5.",
      change_strong: "Use no máximo duas casas decimais.",
      points_strong: "A variação forte em pontos fica acima de 0% e até 20%.",
      min_orders_sample: "A amostra mínima é um número inteiro de pedidos, de 1 a 1.000.",
    });
    expect(lerFormularioDosLimites(formulario({ min_orders_sample: "1.001" })).ok).toBe(false);
    expect(lerFormularioDosLimites(formulario({ min_orders_sample: "1.000" })).ok).toBe(true);
  });
});

describe("descreverLimites (D-408)", () => {
  it("cada campo com o valor atual como se digita e a dica com o padrão", () => {
    const d = descreverLimites(lerLimites(LINHA));

    expect(d.map((x) => [x.campo, x.atual])).toEqual([
      ["change_neutral", "3"],
      ["change_strong", "15"],
      ["points_neutral", "1"],
      ["points_strong", "3"],
      ["goal_delay_warning", "8"],
      ["margin_after_ads_low", "12"],
      ["min_orders_sample", "30"],
    ]);
    expect(d[2]?.dica).toMatch(/Padrão: 0,5\.$/);
    expect(d[6]?.dica).toMatch(/Padrão: 20\.$/);
  });

  it("0,07 não vira 7,000000000000001", () => {
    expect(comoDigitado("change_strong", 0.07)).toBe("7");
    expect(comoDigitado("points_neutral", 0.0025)).toBe("0,25");
  });
});
