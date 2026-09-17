import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  RELIST_USER_PRODUCT_VARIATIONS_DESCRICAO,
  evaluateRelistPreflight,
  relistRejectionFailureReason,
  summarizeRelistVariations,
} from "@sb/domain";

import {
  MENSAGEM_NAO_PERMITIDA,
  MENSAGEM_SEM_REPUBLICACAO,
  RELEITURAS,
  atosDaRepublicacao,
  cienciaDaExecucao,
  cienciaDaRetomada,
  descreverVariacaoFora,
  passoDaReleitura,
  precisaDasVariacoesDoRetrato,
} from "./republicacao";

describe("variações que ficam fora do anúncio novo, na confirmação (D-364)", () => {
  it("a lista vem do retrato do pedido e nomeia cada variação: id, combinação e SKU quando existem", () => {
    // O `parent_snapshot->variations` que a página lê, reduzido: uma zerada com SKU, uma sem nada.
    const variacoes = summarizeRelistVariations({
      variations: [
        { id: 52_844_432_013, price: 114.9, available_quantity: 698, attribute_combinations: [{ name: "Color", value_name: "Preto" }] },
        {
          id: 52_844_432_007,
          price: 114.9,
          available_quantity: 0,
          attribute_combinations: [{ name: "Color", value_name: "Azul" }],
          seller_custom_field: "SB-RETRO-AZUL",
        },
        { id: 52_844_432_008, price: 114.9, available_quantity: 0 },
      ],
    });

    expect(variacoes.total).toBe(3);
    expect(variacoes.leftOut.map(descreverVariacaoFora)).toEqual(["52844432007 · Color: Azul · SKU SB-RETRO-AZUL", "52844432008"]);
  });

  it("com variação de fora, a ciência da execução cobre as duas perdas e a retomada passa a exigir ciência", () => {
    expect(cienciaDaExecucao(0)).toBe("Entendo que fechar este anúncio é irreversível.");
    expect(cienciaDaExecucao(2)).toContain("irreversível");
    expect(cienciaDaExecucao(2)).toContain("nasce sem as variações sem estoque");
    expect(cienciaDaRetomada(0)).toBeUndefined();
    expect(cienciaDaRetomada(1)).toContain("nasce sem as variações sem estoque");
  });
});

describe("espera pelo worker depois de enviar um ato (D-360, D-364)", () => {
  it("relê até a última releitura e, passada ela, desiste — a tela não fica em 'enfileirado' para sempre", () => {
    expect(passoDaReleitura(1)).toBe("reler");
    expect(passoDaReleitura(RELEITURAS)).toBe("reler");
    expect(passoDaReleitura(RELEITURAS + 1)).toBe("desistir");
  });
});

describe("atosDaRepublicacao (D-295, D-364)", () => {
  it("RELIST_FAILED por RECUSA do ML: oferece tentar de novo, com a explicação — e não oferece outro pedido", () => {
    expect(
      atosDaRepublicacao({
        podeRepublicar: true,
        operacao: { status: "RELIST_FAILED", retomavel: true, failureReason: null },
        variacoesDoRetrato: 0,
        aguardandoWorker: false,
      }),
    ).toEqual({ pedir: false, executar: false, retomar: true, falha: "recusada", semRepublicacao: false });
  });

  it("RELIST_FAILED que NÃO é recusa comprovada: nenhum botão, e a tela diz que exige gente", () => {
    expect(
      atosDaRepublicacao({
        podeRepublicar: true,
        operacao: { status: "RELIST_FAILED", retomavel: false, failureReason: null },
        variacoesDoRetrato: 0,
        aguardandoWorker: false,
      }),
    ).toEqual({ pedir: false, executar: false, retomar: false, falha: "exige-gente", semRepublicacao: false });
  });

  it("quem não pode republicar vê a explicação da recusa, mas não o botão", () => {
    expect(
      atosDaRepublicacao({
        podeRepublicar: false,
        operacao: { status: "RELIST_FAILED", retomavel: true, failureReason: null },
        variacoesDoRetrato: 0,
        aguardandoWorker: false,
      }),
    ).toEqual({ pedir: false, executar: false, retomar: false, falha: "recusada", semRepublicacao: false });
  });

  it("depois de enviar a retomada, nada é oferecido até o worker mudar a operação (D-360)", () => {
    expect(
      atosDaRepublicacao({
        podeRepublicar: true,
        operacao: { status: "RELIST_FAILED", retomavel: true, failureReason: null },
        variacoesDoRetrato: 0,
        aguardandoWorker: true,
      }),
    ).toEqual({ pedir: false, executar: false, retomar: false, falha: null, semRepublicacao: false });
  });

  it("os atos de antes continuam: sem operação ou reprovada, pedir; REQUESTED, executar; viva, nada", () => {
    const semOperacao = atosDaRepublicacao({ podeRepublicar: true, operacao: null, variacoesDoRetrato: 0, aguardandoWorker: false });
    expect(semOperacao).toEqual({ pedir: true, executar: false, retomar: false, falha: null, semRepublicacao: false });

    for (const status of ["PREFLIGHT_FAILED", "CLOSE_FAILED"]) {
      expect(
        atosDaRepublicacao({
          podeRepublicar: true,
          operacao: { status, retomavel: false, failureReason: null },
          variacoesDoRetrato: 0,
          aguardandoWorker: false,
        }).pedir,
      ).toBe(true);
    }

    expect(
      atosDaRepublicacao({
        podeRepublicar: true,
        operacao: { status: "REQUESTED", retomavel: false, failureReason: null },
        variacoesDoRetrato: 0,
        aguardandoWorker: false,
      }),
    ).toEqual({ pedir: false, executar: true, retomar: false, falha: null, semRepublicacao: false });

    for (const status of ["CLOSING", "CLOSED", "RELISTING", "RELISTED", "REMAPPED"]) {
      expect(
        atosDaRepublicacao({
          podeRepublicar: true,
          operacao: { status, retomavel: true, failureReason: null },
          variacoesDoRetrato: 0,
          aguardandoWorker: false,
        }),
      ).toEqual({ pedir: false, executar: false, retomar: false, falha: null, semRepublicacao: false });
    }
  });
});

describe("variações em conta de user products (D-369)", () => {
  /** O `failure_reason` REAL da a7638dc5 depois da retomada de 2026-09-17 13:36 UTC. */
  const RECUSA_USER_PRODUCT = relistRejectionFailureReason(
    400,
    "Validation error (validation_error) causas: item.variations.relist.invalid: Relist item with variations are not allowed for user product seller",
  );

  it("RELIST_FAILED recusado com item.variations.relist.invalid: sem botão, e a tela diz que o ML não permite", () => {
    // Mesmo que a elegibilidade calculada viesse `true`, a causa manda.
    for (const retomavel of [false, true]) {
      expect(
        atosDaRepublicacao({
          podeRepublicar: true,
          operacao: { status: "RELIST_FAILED", retomavel, failureReason: RECUSA_USER_PRODUCT },
          variacoesDoRetrato: 0,
          aguardandoWorker: false,
        }),
      ).toEqual({ pedir: false, executar: false, retomar: false, falha: "nao-permitida", semRepublicacao: false });
    }

    expect(MENSAGEM_NAO_PERMITIDA).toBe(
      "O Mercado Livre não permite republicar este anúncio (variações em conta de user products). Nenhum anúncio novo foi criado; o anúncio antigo segue fechado.",
    );
  });

  it("outra recusa 4xx continua oferecendo tentar de novo", () => {
    expect(
      atosDaRepublicacao({
        podeRepublicar: true,
        operacao: {
          status: "RELIST_FAILED",
          retomavel: true,
          failureReason: relistRejectionFailureReason(400, "Validation error causas: item.variations.missing: x"),
        },
        variacoesDoRetrato: 0,
        aguardandoWorker: false,
      }),
    ).toEqual({ pedir: false, executar: false, retomar: true, falha: "recusada", semRepublicacao: false });
  });

  /** O `failure_reason` que o worker grava para o pai do incidente: as descrições dos bloqueios, juntas. */
  function motivoDoPreflight(sellerUserProducts: boolean | null): string {
    const preflight = evaluateRelistPreflight(
      {
        tags: [],
        catalog_listing: false,
        listing_type_id: "gold_special",
        available_quantity: 698,
        variations: [{ id: 52_844_432_013, price: 114.9, available_quantity: 698 }],
      },
      new Map(),
      sellerUserProducts,
    );

    return preflight.blocks.map((block) => block.descricao).join(" ");
  }

  it("A4: reprovada por VARIACOES_USER_PRODUCT (PREFLIGHT_FAILED ou CLOSE_FAILED da retomada de CLOSING) com variações no retrato: sem pedir, só o aviso", () => {
    for (const status of ["PREFLIGHT_FAILED", "CLOSE_FAILED"]) {
      const atos = atosDaRepublicacao({
        podeRepublicar: true,
        operacao: { status, retomavel: false, failureReason: motivoDoPreflight(true) },
        variacoesDoRetrato: 10,
        aguardandoWorker: false,
      });

      expect(atos).toEqual({ pedir: false, executar: false, retomar: false, falha: null, semRepublicacao: true });
    }

    // Quem não pode republicar lê o mesmo aviso.
    expect(
      atosDaRepublicacao({
        podeRepublicar: false,
        operacao: { status: "PREFLIGHT_FAILED", retomavel: false, failureReason: motivoDoPreflight(true) },
        variacoesDoRetrato: 10,
        aguardandoWorker: false,
      }).semRepublicacao,
    ).toBe(true);
  });

  it("A4: o aviso não repete o motivo que a tabela já mostra", () => {
    expect(MENSAGEM_SEM_REPUBLICACAO).not.toContain(RELIST_USER_PRODUCT_VARIATIONS_DESCRICAO);
    expect(MENSAGEM_SEM_REPUBLICACAO).toContain("o motivo está na tabela abaixo");
    expect(MENSAGEM_SEM_REPUBLICACAO).toContain("Nada foi fechado");
  });

  it("A4: o pedido volta quando não é o bloqueio definitivo — conta sem leitura, outro bloqueio, ou retrato sem variações", () => {
    for (const [failureReason, variacoesDoRetrato] of [
      [motivoDoPreflight(null), 10],
      ["O anúncio está sem estoque.", 10],
      [motivoDoPreflight(true), 0],
      [null, 10],
    ] as const) {
      const atos = atosDaRepublicacao({
        podeRepublicar: true,
        operacao: { status: "PREFLIGHT_FAILED", retomavel: false, failureReason },
        variacoesDoRetrato,
        aguardandoWorker: false,
      });

      expect(atos).toEqual({ pedir: true, executar: false, retomar: false, falha: null, semRepublicacao: false });
    }

    // A descrição do bloqueio num estado que FECHOU (ou que ainda vai fechar) não é esta regra.
    for (const status of ["REQUESTED", "RELIST_FAILED"]) {
      expect(
        atosDaRepublicacao({
          podeRepublicar: true,
          operacao: { status, retomavel: false, failureReason: motivoDoPreflight(true) },
          variacoesDoRetrato: 10,
          aguardandoWorker: false,
        }).semRepublicacao,
      ).toBe(false);
    }
  });

  it("B1/R1: precisaDasVariacoesDoRetrato — REQUESTED, RELIST_FAILED e a reprovação por VARIACOES_USER_PRODUCT; nunca a leitura da conta que falhou", () => {
    const casos: readonly (readonly [string, string | null, boolean])[] = [
      ["REQUESTED", null, true],
      ["RELIST_FAILED", relistRejectionFailureReason(400, "causas: item.variations.relist.invalid: x"), true],
      ["RELIST_FAILED", null, true],
      ["PREFLIGHT_FAILED", motivoDoPreflight(true), true],
      ["CLOSE_FAILED", motivoDoPreflight(true), true],
      ["PREFLIGHT_FAILED", motivoDoPreflight(null), false],
      ["CLOSE_FAILED", motivoDoPreflight(null), false],
      ["PREFLIGHT_FAILED", "O anúncio está sem estoque.", false],
      ["PREFLIGHT_FAILED", null, false],
      ["CLOSING", motivoDoPreflight(true), false],
      ["RELISTED", null, false],
      ["REMAPPED", null, false],
    ];

    for (const [status, failure_reason, esperado] of casos) {
      expect(precisaDasVariacoesDoRetrato({ status, failure_reason }), `${status} / ${String(failure_reason)}`).toBe(esperado);
    }

    expect(precisaDasVariacoesDoRetrato(null)).toBe(false);
  });

  it("B1/R1: o caminho da página — só lê o retrato quando precisa, e a reprovação por VARIACOES_USER_PRODUCT fica sem pedido", () => {
    // O retrato do pai do incidente: 10 variações. A página só o lê quando o predicado deixa.
    const retrato = {
      variations: Array.from({ length: 10 }, (_, indice) => ({ id: 52_844_432_000 + indice, price: 114.9, available_quantity: 5 })),
    };

    for (const status of ["PREFLIGHT_FAILED", "CLOSE_FAILED"]) {
      const linha = { id: "a7638dc5", status, failure_reason: motivoDoPreflight(true) };
      const variacoes = summarizeRelistVariations(precisaDasVariacoesDoRetrato(linha) ? retrato : { variations: undefined });
      const atos = atosDaRepublicacao({
        podeRepublicar: true,
        operacao: { status: linha.status, retomavel: false, failureReason: linha.failure_reason },
        variacoesDoRetrato: variacoes.total,
        aguardandoWorker: false,
      });

      expect(variacoes.total).toBe(10);
      expect(atos).toMatchObject({ pedir: false, semRepublicacao: true });
    }
  });

  it("B1/R1: page.tsx condiciona a leitura de parent_snapshot->variations a precisaDasVariacoesDoRetrato(operacaoComoPai)", () => {
    // Guarda da ligação: nenhum teste sem banco renderiza a página. Trocar a
    // condição por outra (ou tirar a leitura) faz este teste falhar — e o A4
    // não volta em silêncio.
    const pagina = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

    expect(pagina).toMatch(
      /precisaDasVariacoesDoRetrato\(operacaoComoPai\)\s*\?\s*supabase\s*\.from\("listing_relists"\)\s*\.select\("variations:parent_snapshot->variations"\)/u,
    );
  });
});
