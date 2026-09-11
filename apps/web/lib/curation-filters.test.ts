import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_SIZE,
  SEM_MARCA,
  buildCurationHref,
  resolveCurationFilters,
  resolveOrdem,
  toCurationRpcArgs,
  type CurationFilters,
} from "./curation-filters";

const base: CurationFilters = {
  estado: "pendente",
  sinal: null,
  marca: null,
  busca: "",
  ordem: "curadoria",
  tamanho: DEFAULT_PAGE_SIZE,
  page: 1,
};

describe("vocabulário", () => {
  it("o padrão é a fila de curadoria, e valor desconhecido cai nela", () => {
    expect(resolveOrdem("atualizado")).toBe("atualizado");
    expect(resolveOrdem("criado")).toBe("criado");
    expect(resolveOrdem("preco")).toBe("curadoria");
    expect(resolveOrdem(undefined)).toBe("curadoria");
  });

  /**
   * A URL é entrada de terceiro: `?tamanho=300000` viraria `limit` e devolveria
   * o catálogo inteiro numa resposta só. A lista é FECHADA, e o que não está
   * nela cai no padrão em silêncio.
   */
  it("tamanho fora da lista fechada cai no padrão, não vira limit", () => {
    expect(resolveCurationFilters({ tamanho: "300" }).tamanho).toBe(300);
    expect(resolveCurationFilters({ tamanho: "20" }).tamanho).toBe(20);
    expect(resolveCurationFilters({ tamanho: "300000" }).tamanho).toBe(DEFAULT_PAGE_SIZE);
    expect(resolveCurationFilters({ tamanho: "37" }).tamanho).toBe(DEFAULT_PAGE_SIZE);
    expect(resolveCurationFilters({ tamanho: "-50" }).tamanho).toBe(DEFAULT_PAGE_SIZE);
    expect(resolveCurationFilters({}).tamanho).toBe(50);
  });

  it("array na query (a mesma chave repetida) lê o primeiro, não estoura", () => {
    expect(resolveCurationFilters({ estado: ["virtual", "fisico"] }).estado).toBe("virtual");
  });
});

describe("href", () => {
  it("o default fica FORA da URL", () => {
    expect(buildCurationHref(base, {})).toBe("/produtos");
    expect(buildCurationHref(base, { tamanho: DEFAULT_PAGE_SIZE })).toBe("/produtos");
    expect(buildCurationHref(base, { ordem: "curadoria" })).toBe("/produtos");
  });

  it("ordem e tamanho compõem com o recorte em vez de substituí-lo", () => {
    const atual: CurationFilters = { ...base, estado: "virtual", busca: "PNEU" };

    expect(buildCurationHref(atual, { ordem: "atualizado", tamanho: 300 })).toBe(
      "/produtos?estado=virtual&busca=PNEU&ordem=atualizado&tamanho=300",
    );
  });

  /**
   * Trocar o TAMANHO volta para a página 1, e não é preciosismo: quem está na
   * página 4 de 300 em 300 e escolhe 20 por página pede um offset de 60 dentro
   * de um conjunto que agora tem outras fronteiras — a tela mostraria linhas
   * que o usuário não pediu, ou nenhuma.
   */
  it("trocar tamanho ou ordem volta para a página 1; paginar preserva o recorte", () => {
    const atual: CurationFilters = { ...base, tamanho: 300, page: 4 };

    expect(buildCurationHref(atual, { tamanho: 20 })).toBe("/produtos?tamanho=20");
    expect(buildCurationHref(atual, { ordem: "criado" })).toBe("/produtos?ordem=criado&tamanho=300");
    expect(buildCurationHref(atual, { page: 5 })).toBe("/produtos?tamanho=300&pagina=5");
  });

  /**
   * `/produtos` era a única tela com `?page=`; o helper compartilhado escreve
   * `?pagina=`, como as outras sete. A escrita unificou, e a LEITURA aceita as
   * duas — link salvo de ontem continua caindo na página certa.
   */
  it("le o nome antigo do parametro de pagina, e escreve o novo", () => {
    expect(resolveCurationFilters({ page: "3" }).page).toBe(3);
    expect(resolveCurationFilters({ pagina: "4" }).page).toBe(4);
    expect(resolveCurationFilters({ pagina: "4", page: "9" }).page).toBe(4);
  });
});

describe("tradução para a RPC", () => {
  it("o offset sai do tamanho ESCOLHIDO, não de uma constante", () => {
    expect(toCurationRpcArgs({ ...base, tamanho: 20, page: 3 })).toMatchObject({
      p_limit: 20,
      p_offset: 40,
    });

    expect(toCurationRpcArgs({ ...base, tamanho: 300, page: 2 })).toMatchObject({
      p_limit: 300,
      p_offset: 300,
    });
  });

  it("a ordem viaja para o banco, e o padrão é explícito", () => {
    expect(toCurationRpcArgs(base).p_order).toBe("curadoria");
    expect(toCurationRpcArgs({ ...base, ordem: "atualizado" }).p_order).toBe("atualizado");
  });

  /** "Sem marca" é RECORTE, não marca: vira `p_missing_brand`, nunca `p_brand`. */
  it("sem marca não vira filtro de marca", () => {
    const recorte = toCurationRpcArgs({ ...base, marca: SEM_MARCA });

    expect(recorte.p_missing_brand).toBe(true);
    expect(recorte.p_brand).toBeUndefined();

    const comMarca = toCurationRpcArgs({ ...base, marca: "OFFRACER" });

    expect(comMarca.p_missing_brand).toBe(false);
    expect(comMarca.p_brand).toBe("OFFRACER");
  });

  it("o estado 'todos' é a AUSÊNCIA do filtro, não um valor", () => {
    expect(toCurationRpcArgs({ ...base, estado: "todos" }).p_classified).toBeUndefined();
    expect(toCurationRpcArgs({ ...base, estado: "virtual" }).p_classified).toBe("VIRTUAL");
  });
});
