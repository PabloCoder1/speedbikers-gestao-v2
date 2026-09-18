import { describe, expect, it } from "vitest";

import { lerVisaoDocumentos, linhaDoLegado, proximoPassoDoDocumento } from "./documents-overview";

/**
 * O contrato de `get_documents_overview` (D-375).
 *
 * Mesmo espírito de `products-overview.test.ts`: o que estes casos protegem é a
 * RECUSA. Uma resposta fora do contrato não pode virar tela com "—" no lugar do
 * número, porque "—" se lê como "não observado" e não como "o SQL mudou".
 */

function respostaValida(): unknown {
  return {
    total: 2,
    linhas: [
      {
        id: "d1",
        file_name: "NFE-4226...xml",
        status: "PARSED",
        operation_type: "ENTRADA",
        document_type: "NFE",
        source_format: "XML",
        document_number: "22",
        series: "3",
        access_key: "42260727810945000206550030000000221215198331",
        issuer_name: "Fornecedor Exemplo LTDA",
        issuer_cnpj: "12345678000190",
        reference: null,
        issue_date: "2026-08-20T12:00:00.000Z",
        total_items: 44,
        resolved_items: 40,
        unidades: 37278,
        valor: 237515.28,
        created_at: "2026-09-17T10:00:00.000Z",
        applied_at: null,
        last_error: null,
      },
    ],
    contagens: {
      estado: { PARSED: 1, APPLIED: 1 },
      direcao: { ENTRADA: 1, SEM_DIRECAO: 1 },
      tipo: { NFE: 1, EM_LEITURA: 1 },
    },
    resumo: {
      total: 2,
      em_conferencia: 1,
      em_leitura: 1,
      falhas: 0,
      aplicados_30d: 1,
      entradas_30d: 1,
      saidas_30d: 0,
      itens_sem_vinculo: 4,
    },
  };
}

describe("leitura do contrato", () => {
  it("lê a página, as contagens e o resumo", () => {
    const visao = lerVisaoDocumentos(respostaValida());

    expect(visao?.total).toBe(2);
    expect(visao?.linhas[0]?.document_number).toBe("22");
    expect(visao?.linhas[0]?.unidades).toBe(37278);
    expect(visao?.contagens.tipo.EM_LEITURA).toBe(1);
    expect(visao?.resumo.itens_sem_vinculo).toBe(4);
  });

  /**
   * O tipo é NULO enquanto o worker não leu o arquivo — é um estado legítimo, e
   * recusá-lo esconderia justamente os documentos que acabaram de chegar.
   */
  it("aceita tipo, direção e chave nulos: documento ainda não lido", () => {
    const dado = respostaValida() as { linhas: Record<string, unknown>[] };

    dado.linhas[0] = {
      ...dado.linhas[0],
      document_type: null,
      operation_type: null,
      access_key: null,
      document_number: null,
      total_items: null,
      resolved_items: null,
    };

    const visao = lerVisaoDocumentos(dado);

    expect(visao?.linhas[0]?.document_type).toBeNull();
    expect(visao?.linhas[0]?.total_items).toBeNull();
  });

  it("campo renomeado no SQL recusa a resposta INTEIRA, não devolve pedaço", () => {
    const dado = respostaValida() as Record<string, unknown>;

    delete (dado.resumo as Record<string, unknown>).itens_sem_vinculo;

    expect(lerVisaoDocumentos(dado)).toBeNull();
  });

  it("número que vem como texto é recusado — não é convertido em silêncio", () => {
    const dado = respostaValida() as { linhas: Record<string, unknown>[] };

    dado.linhas[0] = { ...dado.linhas[0], unidades: "37278" };

    expect(lerVisaoDocumentos(dado)).toBeNull();
  });

  it("contagem com valor não numérico recusa a leitura", () => {
    const dado = respostaValida() as { contagens: { estado: Record<string, unknown> } };

    dado.contagens.estado = { PARSED: null };

    expect(lerVisaoDocumentos(dado)).toBeNull();
  });

  it("resposta que não é objeto não estoura", () => {
    expect(lerVisaoDocumentos(null)).toBeNull();
    expect(lerVisaoDocumentos([])).toBeNull();
    expect(lerVisaoDocumentos("{}")).toBeNull();
  });
});

describe("leitura antiga", () => {
  /**
   * Antes da migration a tela cai na consulta em `documents`, que não conhece
   * tipo, formato nem valor. O que ela não sabe fica NULO — nunca "NFE", que
   * seria um chute com cara de dado.
   */
  it("o que a consulta antiga não sabe fica nulo", () => {
    const linha = linhaDoLegado({
      id: "d1",
      file_name: "nota.xml",
      status: "PARSED",
      operation_type: "ENTRADA",
      document_number: "22",
      series: null,
      access_key: null,
      issuer_name: null,
      issue_date: null,
      total_items: 3,
      resolved_items: 1,
      created_at: "2026-09-17T10:00:00.000Z",
      applied_at: null,
      last_error: null,
    });

    expect(linha.document_type).toBeNull();
    expect(linha.source_format).toBeNull();
    expect(linha.reference).toBeNull();
  });
});

describe("próximo passo", () => {
  const base = linhaDoLegado({
    id: "d1",
    file_name: "nota.xml",
    status: "PARSED",
    operation_type: "ENTRADA",
    document_number: "22",
    series: null,
    access_key: null,
    issuer_name: null,
    issue_date: null,
    total_items: 4,
    resolved_items: 1,
    created_at: "2026-09-17T10:00:00.000Z",
    applied_at: null,
    last_error: null,
  });

  it("em conferência, diz quantos itens faltam vincular", () => {
    expect(proximoPassoDoDocumento(base)).toEqual({ texto: "Vincular 3 de 4", tom: "atencao" });
  });

  it("tudo vinculado: o passo é aplicar", () => {
    expect(proximoPassoDoDocumento({ ...base, resolved_items: 4 })).toEqual({
      texto: "Conferido · aplicar",
      tom: "ok",
    });
  });

  /**
   * A regra combinada com a frente do Full: envio ao Full é TRANSFERÊNCIA, e a
   * tela não pode oferecer "aplicar" para algo que a `api` vai recusar (D-352).
   */
  it("envio ao Full não oferece baixa, mesmo conferido", () => {
    const linha = { ...base, resolved_items: 4, document_type: "ENVIO_FULL_ML_PDF" };

    expect(proximoPassoDoDocumento(linha)).toEqual({ texto: "Full · sem baixa", tom: "neutro" });
  });

  it("documento lido sem nenhum item é problema, não conferência vazia", () => {
    const linha = { ...base, total_items: 0, resolved_items: 0 };

    expect(proximoPassoDoDocumento(linha)).toEqual({ texto: "Nenhum item lido", tom: "perigo" });
  });

  it("os estados de máquina não pedem ação de gente", () => {
    expect(proximoPassoDoDocumento({ ...base, status: "UPLOADED" }).texto).toBe("Lendo o arquivo…");
    expect(proximoPassoDoDocumento({ ...base, status: "APPLYING" }).texto).toBe("Aplicando…");
    expect(proximoPassoDoDocumento({ ...base, status: "FAILED" }).tom).toBe("perigo");
    expect(proximoPassoDoDocumento({ ...base, status: "APPLIED" }).tom).toBe("ok");
  });
});
