import { describe, expect, it } from "vitest";

import {
  PAGE_SIZE,
  buildReplenishmentHref,
  resolveReplenishmentFilters,
  summarizeReplenishmentWindow,
} from "./replenishment-filters";

const vazio = { brand: null, state: null, search: null, page: 1 };

describe("resolveReplenishmentFilters", () => {
  it("lê as dimensões da URL", () => {
    const f = resolveReplenishmentFilters({ marca: "NAVETEC", estado: "RUPTURA", busca: "3001", pagina: "3" });

    expect(f).toEqual({ brand: "NAVETEC", state: "RUPTURA", search: "3001", page: 3, marginDays: 30, compra: null });
  });

  it("período da margem: só 7, 15, 30, 60 e 90; o padrão fica fora da URL (D-720)", () => {
    expect(resolveReplenishmentFilters({ margem: "90" }).marginDays).toBe(90);
    expect(resolveReplenishmentFilters({ margem: "45" }).marginDays).toBe(30);
    expect(buildReplenishmentHref(resolveReplenishmentFilters({ margem: "90" }), {})).toBe("/reposicao?margem=90");
    expect(buildReplenishmentHref(resolveReplenishmentFilters({}), { marginDays: 30 })).toBe("/reposicao");
  });

  it("string vazia e espaços viram null, não filtro que não casa com nada", () => {
    expect(resolveReplenishmentFilters({ marca: "" }).brand).toBeNull();
    expect(resolveReplenishmentFilters({ busca: "   " }).search).toBeNull();
  });

  it("página tem piso 1", () => {
    expect(resolveReplenishmentFilters({ pagina: "0" }).page).toBe(1);
    expect(resolveReplenishmentFilters({ pagina: "abc" }).page).toBe(1);
  });
});

describe("buildReplenishmentHref", () => {
  it("sem filtro nenhum devolve a URL limpa", () => {
    expect(buildReplenishmentHref(vazio, {})).toBe("/reposicao");
  });

  it("preserva as outras dimensões ao trocar uma", () => {
    const atual = { ...vazio, brand: "NAVETEC" };

    expect(buildReplenishmentHref(atual, { search: "manete" })).toBe("/reposicao?marca=NAVETEC&busca=manete");
  });

  it("estado entra na URL como `estado` e convive com marca e busca (D-250)", () => {
    // As três dimensões são independentes e componíveis: clicar num cartão de
    // estado não pode descartar a marca escolhida antes.
    const atual = { ...vazio, brand: "NAVETEC", state: "RUPTURA", search: "manete" };

    expect(buildReplenishmentHref(atual, {})).toBe("/reposicao?marca=NAVETEC&estado=RUPTURA&busca=manete");
    expect(buildReplenishmentHref(atual, { state: null })).toBe("/reposicao?marca=NAVETEC&busca=manete");
  });

  it("`SEM_ESTADO` é valor de filtro como qualquer outro — é 86% do catálogo", () => {
    expect(buildReplenishmentHref({ ...vazio, state: "SEM_ESTADO" }, {})).toBe("/reposicao?estado=SEM_ESTADO");
  });

  it("trocar de filtro VOLTA para a página 1", () => {
    const naPagina5 = { ...vazio, page: 5 };

    expect(buildReplenishmentHref(naPagina5, { brand: "RT" })).not.toContain("pagina");
  });

  it("navegar entre páginas preserva a página pedida", () => {
    const atual = { ...vazio, brand: "RT", page: 2 };

    expect(buildReplenishmentHref(atual, { page: 3 })).toBe("/reposicao?marca=RT&pagina=3");
  });
});

describe("summarizeReplenishmentWindow", () => {
  it("diz o total real, não o tamanho da página", () => {
    const r = summarizeReplenishmentWindow(1, 3276, PAGE_SIZE);

    expect(r.label).toContain("3.276");
    expect(r.label).toContain("1 a 100");
    expect(r.totalPages).toBe(33);
  });

  it("uma página só não vira ruído de intervalo", () => {
    expect(summarizeReplenishmentWindow(1, 40, 40).label).toBe("40 SKUs.");
  });

  it("filtro de compra: só os códigos do SQL; desconhecido volta a todos (D-763)", () => {
    expect(resolveReplenishmentFilters({ compra: "COMPLEMENTAR" }).compra).toBe("COMPLEMENTAR");
    expect(resolveReplenishmentFilters({ compra: "QUALQUER" }).compra).toBeNull();
    expect(buildReplenishmentHref(resolveReplenishmentFilters({ marca: "X" }), { compra: "ATRASADO" })).toBe(
      "/reposicao?marca=X&compra=ATRASADO",
    );
    expect(buildReplenishmentHref(resolveReplenishmentFilters({ compra: "ATRASADO", pagina: "2" }), { compra: null })).toBe("/reposicao");
  });
});
