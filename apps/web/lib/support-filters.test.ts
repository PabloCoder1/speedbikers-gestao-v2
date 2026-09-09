import { describe, expect, it } from "vitest";

import { isPageBeyondEnd } from "./filters";
import { buildSupportHref, resolveSupportFilters, type SupportFilters } from "./support-filters";

/**
 * Os filtros da Caixa de Entrada (D-289).
 *
 * Dois assuntos, e os dois já custaram defeito nesta casa: **valor forjado na
 * URL não pode virar predicado** (a defesa que as listas fechadas fazem) e
 * **trocar filtro tem de voltar à página 1** (D-138/D-139) — com a exceção
 * declarada do `?volta=`, que precisa da página preservada para não devolver
 * quem leu o caso da página 7 para o começo da fila.
 */

const LIMPOS: SupportFilters = {
  account: null,
  channel: null,
  status: "abertos",
  prazo: false,
  page: 1,
};

describe("resolveSupportFilters", () => {
  it("aceita só o que é do vocabulário e cai no default em silêncio", () => {
    expect(resolveSupportFilters({ canal: "DROP TABLE", status: "qualquer" })).toEqual(LIMPOS);
  });

  it("lê as quatro dimensões e a página", () => {
    expect(
      resolveSupportFilters({
        account: "loja-x",
        canal: "CLAIM",
        status: "EM_ATENDIMENTO",
        prazo: "risco",
        pagina: "3",
      }),
    ).toEqual({
      account: "loja-x",
      channel: "CLAIM",
      status: "EM_ATENDIMENTO",
      prazo: true,
      page: 3,
    });
  });

  it("página não numérica, zero ou negativa cai em 1 — offset negativo é erro do Postgres", () => {
    for (const pagina of ["0", "-4", "abc", ""]) {
      expect(resolveSupportFilters({ pagina }).page).toBe(1);
    }

    // Fracionário TRUNCA, não cai em 1 — comportamento de `resolvePageParam`,
    // afirmado em `filters.test.ts` ("2.9" → 2). Repito aqui só porque
    // escrevi o contrário primeiro e o teste me corrigiu.
    expect(resolveSupportFilters({ pagina: "2.9" }).page).toBe(2);
  });

  it("`prazo` só liga com o valor exato que a tela escreve", () => {
    expect(resolveSupportFilters({ prazo: "risco" }).prazo).toBe(true);
    expect(resolveSupportFilters({ prazo: "sim" }).prazo).toBe(false);
  });
});

describe("buildSupportHref", () => {
  it("o recorte limpo é a rota nua", () => {
    expect(buildSupportHref(LIMPOS, {})).toBe("/atendimento");
  });

  it("trocar um filtro preserva os outros E volta à página 1", () => {
    const atual: SupportFilters = { account: "loja-x", channel: "CLAIM", status: "NOVO", prazo: true, page: 7 };

    const href = buildSupportHref(atual, { channel: "QUESTION" });

    expect(href).toContain("account=loja-x");
    expect(href).toContain("canal=QUESTION");
    expect(href).toContain("status=NOVO");
    expect(href).toContain("prazo=risco");
    expect(href).not.toContain("pagina");
  });

  it("a página só sobrevive quando é pedida — é o caso do `?volta=`", () => {
    const atual: SupportFilters = { ...LIMPOS, page: 7 };

    expect(buildSupportHref(atual, { page: atual.page })).toBe("/atendimento?pagina=7");
    expect(buildSupportHref(atual, {})).toBe("/atendimento");
  });

  it("`abertos` é o default e fica FORA da URL", () => {
    expect(buildSupportHref(LIMPOS, { status: "abertos" })).toBe("/atendimento");
    expect(buildSupportHref(LIMPOS, { status: "RESOLVIDO" })).toBe("/atendimento?status=RESOLVIDO");
  });
});

describe("isPageBeyondEnd", () => {
  /*
    Medido no local com `support_cases` (2 linhas): `range(0, 99)` devolve 200
    com as 2; `range(100, 199)` devolve **416 `PGRST103`** e `count` nulo. É
    isso que separa "página que passou do fim" de "falha de leitura" na tela.
  */
  it("reconhece o 416 do PostgREST, e só ele", () => {
    expect(isPageBeyondEnd({ code: "PGRST103" })).toBe(true);
    expect(isPageBeyondEnd({ code: "PGRST301" })).toBe(false);
    expect(isPageBeyondEnd(null)).toBe(false);
    expect(isPageBeyondEnd(undefined)).toBe(false);
  });
});
