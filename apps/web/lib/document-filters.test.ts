import { describe, expect, it } from "vitest";

import {
  PAGE_SIZE,
  buildDocumentHref,
  resolveDocumentFilters,
  resolveDocumentStatus,
  resolveDocumentType,
  resolveOperationType,
  summarizeDocumentWindow,
  type DocumentFilters,
} from "./document-filters";

const base: DocumentFilters = {
  status: null,
  operation: null,
  type: null,
  search: null,
  page: 1,
};

describe("estado e direção", () => {
  it("resolve os sete estados do ciclo de docs/NFE.md", () => {
    for (const estado of ["UPLOADED", "PARSING", "PARSED", "APPLYING", "APPLIED", "FAILED", "CANCELLED"]) {
      expect(resolveDocumentStatus(estado)).toBe(estado);
    }
  });

  /**
   * Estado inventado na URL cai em "todos", nunca vai ao banco: se fosse
   * adiante, a consulta voltaria vazia — e zero linhas é indistinguível de um
   * filtro legítimo sem resultado (lição de D-242).
   */
  it("estado fora da lista fechada vira nulo, não uma consulta vazia", () => {
    expect(resolveDocumentStatus("PROCESSANDO")).toBeNull();
    expect(resolveDocumentStatus("applied")).toBeNull();
    expect(resolveDocumentStatus(undefined)).toBeNull();
    expect(resolveDocumentStatus(42)).toBeNull();
  });

  /**
   * Os quatro layouts de D-375. Tipo inventado na URL cai em "todos" pelo mesmo
   * motivo do estado: zero linhas não se distingue de filtro sem resultado.
   */
  it("tipo aceita só os quatro layouts lidos", () => {
    for (const tipo of ["NFE", "DANFE_PDF", "SAIDA_UPSELLER_PDF", "ENVIO_FULL_ML_PDF"]) {
      expect(resolveDocumentType(tipo)).toBe(tipo);
    }

    expect(resolveDocumentType("NFSE")).toBeNull();
    expect(resolveDocumentType("EM_LEITURA")).toBeNull();
  });

  it("direção aceita só as duas do domínio", () => {
    expect(resolveOperationType("ENTRADA")).toBe("ENTRADA");
    expect(resolveOperationType("SAIDA")).toBe("SAIDA");
    expect(resolveOperationType("DEVOLUCAO")).toBeNull();
  });
});

describe("resolução da URL", () => {
  it("lê as quatro dimensões mais a página", () => {
    const filtros = resolveDocumentFilters({
      estado: "PARSED",
      direcao: "ENTRADA",
      tipo: "DANFE_PDF",
      busca: "OUT12467",
      pagina: "3",
    });

    expect(filtros).toEqual({
      status: "PARSED",
      operation: "ENTRADA",
      type: "DANFE_PDF",
      search: "OUT12467",
      page: 3,
    });
  });

  it("busca em branco é ausência de busca, não busca por vazio", () => {
    expect(resolveDocumentFilters({ busca: "   " })).toEqual(base);
  });

  it("parâmetro que a tela não tem é ignorado", () => {
    expect(resolveDocumentFilters({ ordem: "valor" })).toEqual(base);
  });
});

describe("href", () => {
  it("o default fica FORA da URL", () => {
    expect(buildDocumentHref(base, {})).toBe("/notas-fiscais");
  });

  it("preserva as outras dimensões ao trocar uma", () => {
    const atual: DocumentFilters = { ...base, status: "PARSED", operation: "ENTRADA", page: 4 };

    expect(buildDocumentHref(atual, { status: "APPLIED" })).toBe(
      "/notas-fiscais?estado=APPLIED&direcao=ENTRADA",
    );
  });

  /**
   * Manter o offset ao trocar o CONJUNTO mostraria uma página vazia que o
   * usuário lê como "nenhum resultado" — a regra de `buildFilterHref`.
   */
  it("trocar de filtro volta para a página 1; paginar preserva o recorte", () => {
    const atual: DocumentFilters = { ...base, status: "PARSED", page: 4 };

    expect(buildDocumentHref(atual, { operation: "SAIDA" })).toBe(
      "/notas-fiscais?estado=PARSED&direcao=SAIDA",
    );
    expect(buildDocumentHref(atual, { page: 2 })).toBe("/notas-fiscais?estado=PARSED&pagina=2");
  });
});

describe("janela declarada", () => {
  /**
   * O defeito que motivou a janela: a tela lia `.limit(50)` e não dizia que
   * havia corte. Com 63 notas, a primeira página precisa AFIRMAR que mostra 50
   * de 63 — nunca deixar as 13 restantes invisíveis (D-131).
   */
  it("com mais notas que a página, a frase declara o corte", () => {
    const janela = summarizeDocumentWindow(1, 63, PAGE_SIZE);

    expect(janela.label).toBe("Mostrando 1 a 50 de 63 notas.");
    expect(janela.totalPages).toBe(2);
  });

  it("cabendo tudo numa página, a frase é só o total", () => {
    expect(summarizeDocumentWindow(1, 7, 7).label).toBe("7 notas.");
  });

  it("flexiona pelo total, não pela página", () => {
    expect(summarizeDocumentWindow(1, 1, 1).label).toBe("1 nota.");
  });

  it("vazio diz por que está vazio", () => {
    expect(summarizeDocumentWindow(1, 0, 0).label).toBe("Nenhuma nota fiscal com estes filtros.");
    expect(summarizeDocumentWindow(1, 0, 0).totalPages).toBe(0);
  });
});
