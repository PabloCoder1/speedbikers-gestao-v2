import { describe, expect, it } from "vitest";

import { isPageBeyondEnd } from "./filters";
import {
  buildSupportHref,
  classifySupportSearch,
  resolveSupportFilters,
  type SupportFilters,
} from "./support-filters";

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
  prazo: null,
  mine: false,
  mediation: false,
  search: null,
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
      prazo: "risco",
      mine: false,
      mediation: false,
      search: null,
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

  it("`prazo` só aceita os três recortes que a tela escreve", () => {
    expect(resolveSupportFilters({ prazo: "risco" }).prazo).toBe("risco");
    expect(resolveSupportFilters({ prazo: "vencido" }).prazo).toBe("vencido");
    expect(resolveSupportFilters({ prazo: "24h" }).prazo).toBe("24h");
    expect(resolveSupportFilters({ prazo: "sim" }).prazo).toBeNull();
  });

  it("meus, mediação e busca (lote 2 do pente fino)", () => {
    expect(resolveSupportFilters({ meus: "1", mediacao: "1", busca: "  2000012345 " })).toMatchObject({
      mine: true,
      mediation: true,
      search: "2000012345",
    });
    expect(resolveSupportFilters({ meus: "sim", mediacao: "0", busca: "   " })).toMatchObject({
      mine: false,
      mediation: false,
      search: null,
    });
  });
});

describe("buildSupportHref", () => {
  it("o recorte limpo é a rota nua", () => {
    expect(buildSupportHref(LIMPOS, {})).toBe("/atendimento");
  });

  it("trocar um filtro preserva os outros E volta à página 1", () => {
    const atual: SupportFilters = { ...LIMPOS, account: "loja-x", channel: "CLAIM", status: "NOVO", prazo: "risco", page: 7 };

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

describe("filtros novos na URL e a busca (lote 2 do pente fino)", () => {
  it("meus, mediação e busca entram na URL e voltam à página 1", () => {
    const href = buildSupportHref({ ...LIMPOS, page: 4 }, { mine: true, mediation: true, search: "MLB123" });

    expect(href).toBe("/atendimento?meus=1&mediacao=1&busca=MLB123");
  });

  it("classifica o texto da busca", () => {
    expect(classifySupportSearch("2000012345")).toEqual({ kind: "numero", value: "2000012345" });
    expect(classifySupportSearch("mlb800000001")).toEqual({ kind: "anuncio", value: "MLB800000001" });
    expect(classifySupportSearch("E2E-SKU-001")).toEqual({ kind: "sku", value: "E2E-SKU-001" });
  });
});
