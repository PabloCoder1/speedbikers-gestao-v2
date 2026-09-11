import { describe, expect, it } from "vitest";

import {
  PAGE_SIZE,
  buildLinkIntegrityHref,
  buildManualLinkHref,
  resolveLinkState,
  resolveSold,
  summarizeLinkIntegrityWindow,
  toRpcArgs,
  type LinkIntegrityFilters,
} from "./link-integrity-filters";

const base: LinkIntegrityFilters = {
  state: "todos",
  sold: "todos",
  accountSlug: null,
  search: null,
  page: 1,
};

describe("vocabulário", () => {
  it("resolve os três estados de vínculo", () => {
    expect(resolveLinkState("vinculados")).toBe("vinculados");
    expect(resolveLinkState("sem-vinculo")).toBe("sem-vinculo");
    expect(resolveLinkState("todos")).toBe("todos");
  });

  it("valor desconhecido cai em todos, nunca numa consulta vazia", () => {
    expect(resolveLinkState("orfaos")).toBe("todos");
    expect(resolveSold("talvez")).toBe("todos");
    expect(resolveLinkState(undefined)).toBe("todos");
  });
});

describe("tradução para a RPC", () => {
  /**
   * O vocabulário da URL é do usuário; o da RPC é do banco. Este é o único
   * ponto que conhece os dois, e é ele que impede "sem-vinculo" de virar
   * `sku_id is null` em vez de `link_state = 'unlinked'` (D-122).
   */
  it("mapeia estado e venda para os argumentos do banco", () => {
    expect(toRpcArgs({ ...base, state: "sem-vinculo" }).p_link_state).toBe("unlinked");
    expect(toRpcArgs({ ...base, state: "vinculados" }).p_link_state).toBe("linked");
    expect(toRpcArgs(base).p_link_state).toBe("all");

    expect(toRpcArgs({ ...base, sold: "vendeu" }).p_sold).toBe("with");
    expect(toRpcArgs({ ...base, sold: "nao-vendeu" }).p_sold).toBe("without");
    expect(toRpcArgs(base).p_sold).toBe("all");
  });

  /**
   * A célula "Vendidos sem vínculo" é a INTERSEÇÃO de dois predicados, e é
   * assim que ela sai da mesma consulta da lista (D-242) em vez de virar uma
   * contagem própria.
   */
  it("a célula mais importante da tela é a interseção dos dois", () => {
    const recorte = toRpcArgs({ ...base, state: "sem-vinculo", sold: "vendeu" });

    expect(recorte).toEqual({ p_link_state: "unlinked", p_sold: "with" });
  });
});

describe("href", () => {
  it("o default fica FORA da URL", () => {
    expect(buildLinkIntegrityHref(base, {})).toBe("/vinculacoes");
  });

  it("compõe estado e venda sem descartar um ao trocar o outro", () => {
    const comEstado = buildLinkIntegrityHref(base, { state: "sem-vinculo" });
    expect(comEstado).toBe("/vinculacoes?estado=sem-vinculo");

    const atual: LinkIntegrityFilters = { ...base, state: "sem-vinculo", sold: "vendeu" };
    expect(buildLinkIntegrityHref(atual, { accountSlug: "e2e-loja" })).toBe(
      "/vinculacoes?estado=sem-vinculo&venda=vendeu&conta=e2e-loja",
    );
  });

  it("trocar de filtro volta para a página 1; paginar preserva o recorte", () => {
    const atual: LinkIntegrityFilters = { ...base, state: "sem-vinculo", page: 4 };

    expect(buildLinkIntegrityHref(atual, { sold: "vendeu" })).toBe(
      "/vinculacoes?estado=sem-vinculo&venda=vendeu",
    );
    expect(buildLinkIntegrityHref(atual, { page: 2 })).toBe(
      "/vinculacoes?estado=sem-vinculo&pagina=2",
    );
  });
});

describe("href da vinculação manual", () => {
  /**
   * O link da linha carrega as DUAS coisas na mesma URL: o recorte de conta
   * (slug, o mesmo vocabulário do filtro) e o MLB que o formulário pré-preenche.
   * Um id cru aqui abriria um segundo vocabulário para a dimensão "conta".
   */
  it("leva conta e MLB, e termina no formulário", () => {
    expect(buildManualLinkHref(base, { accountSlug: "e2e-loja", itemId: "MLB123" })).toBe(
      "/vinculacoes?conta=e2e-loja&item=MLB123#vincular-a-mao",
    );
  });

  it("preserva o recorte de quem clicou, menos a página", () => {
    const atual: LinkIntegrityFilters = { ...base, state: "sem-vinculo", sold: "vendeu", search: "PNEU", page: 4 };

    expect(buildManualLinkHref(atual, { accountSlug: "e2e-loja", itemId: "MLB123" })).toBe(
      "/vinculacoes?estado=sem-vinculo&venda=vendeu&conta=e2e-loja&busca=PNEU&item=MLB123#vincular-a-mao",
    );
  });

  it("sem conta conhecida, o MLB ainda viaja", () => {
    expect(buildManualLinkHref(base, { accountSlug: null, itemId: "MLB123" })).toBe(
      "/vinculacoes?item=MLB123#vincular-a-mao",
    );
  });
});

describe("janela declarada", () => {
  it("com mais anúncios que a página, a frase declara o corte", () => {
    const janela = summarizeLinkIntegrityWindow(1, 863, PAGE_SIZE);

    expect(janela.label).toBe("Mostrando 1 a 50 de 863 anúncios.");
    expect(janela.totalPages).toBe(18);
  });

  it("flexiona pelo total", () => {
    expect(summarizeLinkIntegrityWindow(1, 1, 1).label).toBe("1 anúncio.");
  });

  it("vazio diz por que está vazio", () => {
    expect(summarizeLinkIntegrityWindow(1, 0, 0).label).toBe("Nenhum anúncio com estes filtros.");
  });
});
