import { describe, expect, it } from "vitest";

import { DEFAULT_PERIOD_DAYS, HOME_SERIE_DEFAULT_DAYS, PERIOD_PRESETS, resolvePeriodDays } from "./period";

/**
 * O vocabulário de período (D-308, mudado de casa em D-311).
 *
 * Os casos guardam a REGRA, não a implementação: lista fechada, e o padrão de
 * cada tela preservado — a tela sempre mostrou 30, e mudar isso em silêncio
 * mudaria todo número de venda que alguém já viu.
 */
describe("vocabulário de período", () => {
  it("são CINCO, e a lista é a mesma para toda tela — 30 dias precisa querer dizer a mesma coisa em todas", () => {
    expect([...PERIOD_PRESETS]).toEqual([7, 15, 30, 60, 90]);
  });

  it("o padrão continua 30 dias, que é o que /vendas e /anuncios mostravam antes de existir seletor", () => {
    expect(DEFAULT_PERIOD_DAYS).toBe(30);
    expect(resolvePeriodDays(undefined)).toBe(30);
    expect(resolvePeriodDays(null)).toBe(30);
  });

  /*
    O PADRÃO DA HOME É 15, E O FRAME DIZ 14. O caso existe para que a troca
    seja deliberada: se alguém "corrigir" para 14 achando que segue o desenho,
    isto fica vermelho e manda ler o porquê — 14 não está na lista fechada, e
    uma sexta opção só para a Home recriaria a divergência que D-308 fechou.
  */
  it("o padrão da Home é 15 — o `14` do frame não está na lista, e uma sexta opção seria a divergência de volta", () => {
    expect(HOME_SERIE_DEFAULT_DAYS).toBe(15);
    expect([...PERIOD_PRESETS]).toContain(HOME_SERIE_DEFAULT_DAYS);
    expect([...PERIOD_PRESETS]).not.toContain(14);
  });

  it("cada tela escolhe o PRÓPRIO padrão, e ele vale quando o parâmetro não vem", () => {
    expect(resolvePeriodDays(undefined, HOME_SERIE_DEFAULT_DAYS)).toBe(15);
    expect(resolvePeriodDays("abacaxi", HOME_SERIE_DEFAULT_DAYS)).toBe(15);
    // E um preset legítimo continua ganhando do padrão da tela.
    expect(resolvePeriodDays("90", HOME_SERIE_DEFAULT_DAYS)).toBe(90);
  });

  it("período fora da lista cai no padrão — nunca vira janela que ninguém pediu", () => {
    // 3650 dias varreria dez anos de métrica sem a tela anunciar.
    expect(resolvePeriodDays("3650")).toBe(30);
    expect(resolvePeriodDays("0")).toBe(30);
    expect(resolvePeriodDays("-7")).toBe(30);
    expect(resolvePeriodDays("abacaxi")).toBe(30);
  });

  it("preset legítimo passa", () => {
    expect(resolvePeriodDays("7")).toBe(7);
    expect(resolvePeriodDays("90")).toBe(90);
  });

  it("`7` como NÚMERO não passa — a URL entrega string, e aceitar os dois esconderia um chamador errado", () => {
    expect(resolvePeriodDays(7)).toBe(30);
  });
});
