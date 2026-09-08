import { describe, expect, it } from "vitest";

import {
  ACTIONS_PAGE_SIZE,
  buildActionsHref,
  facetEntries,
  isQueueRow,
  readFacet,
  resolveActionFilters,
  resolveSeverity,
  toRpcArgs,
  type ActionFilters,
} from "./action-filters";

const base: ActionFilters = { severity: "todas", kind: null, page: 1 };

describe("prioridade", () => {
  it("resolve os três valores que a constraint tem, mais 'todas'", () => {
    expect(resolveSeverity("alta")).toBe("alta");
    expect(resolveSeverity("media")).toBe("media");
    expect(resolveSeverity("baixa")).toBe("baixa");
    expect(resolveSeverity("todas")).toBe("todas");
  });

  /**
   * O frame desenha quatro níveis e o primeiro é "Crítica". Ele NÃO existe:
   * `check (severity in ('baixa','media','alta'))`. Mandá-lo ao banco voltaria
   * sempre vazio, indistinguível de um filtro legítimo sem resultado (D-242).
   */
  it("'critica', que o frame pede, cai em todas e não vai ao banco", () => {
    expect(resolveSeverity("critica")).toBe("todas");
    expect(toRpcArgs({ ...base, severity: resolveSeverity("critica") }).p_severity).toBeNull();
  });

  it("lixo e ausência caem em todas", () => {
    expect(resolveSeverity(undefined)).toBe("todas");
    expect(resolveSeverity(42)).toBe("todas");
    expect(resolveSeverity("")).toBe("todas");
  });
});

describe("leitura da URL", () => {
  it("lê prioridade, tipo e página", () => {
    expect(resolveActionFilters({ prioridade: "alta", tipo: "venda_anomala", pagina: "3" })).toEqual({
      severity: "alta",
      kind: "venda_anomala",
      page: 3,
    });
  });

  it("URL limpa é o default", () => {
    expect(resolveActionFilters({})).toEqual(base);
  });

  it("tipo em branco não vira filtro", () => {
    expect(resolveActionFilters({ tipo: "   " }).kind).toBeNull();
  });

  /**
   * `kind` é texto LIVRE no banco — não há lista para validar contra, então um
   * tipo desconhecido vai ao banco como veio. Quem impede o zero mudo é a
   * linha-sentinela, que traz as facetas mesmo com a página vazia.
   */
  it("tipo desconhecido passa adiante, porque kind não tem constraint", () => {
    expect(resolveActionFilters({ tipo: "tipo_novo" }).kind).toBe("tipo_novo");
    expect(toRpcArgs({ ...base, kind: "tipo_novo" }).p_kind).toBe("tipo_novo");
  });
});

describe("href", () => {
  it("o default fica FORA da URL", () => {
    expect(buildActionsHref(base, {})).toBe("/acoes");
  });

  it("compõe prioridade e tipo sem descartar um ao trocar o outro", () => {
    const comPrioridade: ActionFilters = { severity: "alta", kind: null, page: 1 };

    expect(buildActionsHref(comPrioridade, { kind: "venda_anomala" })).toBe(
      "/acoes?prioridade=alta&tipo=venda_anomala",
    );
  });

  /** Manter o offset ao mudar o CONJUNTO mostraria página vazia lida como "nada encontrado". */
  it("trocar filtro volta para a página 1", () => {
    const naPagina4: ActionFilters = { severity: "todas", kind: null, page: 4 };

    expect(buildActionsHref(naPagina4, { severity: "alta" })).toBe("/acoes?prioridade=alta");
  });

  it("mas paginar preserva o filtro", () => {
    const comFiltro: ActionFilters = { severity: "alta", kind: null, page: 1 };

    expect(buildActionsHref(comFiltro, { page: 2 })).toBe("/acoes?prioridade=alta&pagina=2");
  });
});

describe("argumentos da RPC", () => {
  it("o offset segue o tamanho de página", () => {
    expect(toRpcArgs({ ...base, page: 1 }).p_offset).toBe(0);
    expect(toRpcArgs({ ...base, page: 3 }).p_offset).toBe(ACTIONS_PAGE_SIZE * 2);
  });

  it("'todas' vira null — sem predicado, não um predicado que casa tudo", () => {
    expect(toRpcArgs(base).p_severity).toBeNull();
    expect(toRpcArgs(base).p_kind).toBeNull();
  });
});

describe("linha-sentinela", () => {
  /**
   * A RPC faz `facetas left join base`: página vazia devolve UMA linha com as
   * colunas da ação em null, só para carregar as contagens do painel. Sem esse
   * descarte a tela renderizaria um cartão fantasma.
   */
  it("a sentinela é descartada, a ação de verdade fica", () => {
    const linhas = [{ id: null }, { id: "abc" }];

    expect(linhas.filter(isQueueRow)).toEqual([{ id: "abc" }]);
  });

  it("página cheia não perde nada", () => {
    const linhas = [{ id: "a" }, { id: "b" }];

    expect(linhas.filter(isQueueRow)).toHaveLength(2);
  });
});

describe("facetas", () => {
  it("lê a contagem de uma chave presente", () => {
    expect(readFacet({ alta: 238, media: 1164 }, "alta")).toBe(238);
  });

  /**
   * Chave ausente é zero MEDIDO: o mapa sai de `jsonb_object_agg` sobre o inbox
   * inteiro, então valor que não aparece é valor sem linha. `severity='baixa'`
   * tem zero no Dev, e mostrar "Baixa 0" é mais honesto do que sumir com a linha.
   */
  it("chave ausente é zero, não desconhecido", () => {
    expect(readFacet({ alta: 238 }, "baixa")).toBe(0);
    expect(readFacet({}, "alta")).toBe(0);
  });

  it("faceta ausente ou malformada não quebra a tela", () => {
    expect(readFacet(null, "alta")).toBe(0);
    expect(readFacet("nao é objeto", "alta")).toBe(0);
    expect(readFacet({ alta: "238" }, "alta")).toBe(0);
  });

  it("os tipos vêm do dado, do mais numeroso ao menos", () => {
    expect(facetEntries({ reclamacoes_recorrentes: 47, venda_anomala: 1402 })).toEqual([
      { key: "venda_anomala", count: 1402 },
      { key: "reclamacoes_recorrentes", count: 47 },
    ]);
  });

  it("empate desempata por nome, para a ordem não oscilar entre carregamentos", () => {
    expect(facetEntries({ zeta: 5, alfa: 5 }).map((e) => e.key)).toEqual(["alfa", "zeta"]);
  });

  it("faceta vazia é lista vazia", () => {
    expect(facetEntries({})).toEqual([]);
    expect(facetEntries(null)).toEqual([]);
  });
});
