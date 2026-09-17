import { describe, expect, it } from "vitest";

import { evaluateRelistPreflight, relistRejectionFailureReason, summarizeRelistVariations } from "@sb/domain";

import {
  MENSAGEM_NAO_PERMITIDA,
  RELEITURAS,
  atosDaRepublicacao,
  cienciaDaExecucao,
  cienciaDaRetomada,
  descreverVariacaoFora,
  passoDaReleitura,
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
        aguardandoWorker: false,
      }),
    ).toEqual({ pedir: false, executar: false, retomar: true, falha: "recusada", bloqueio: null });
  });

  it("RELIST_FAILED que NÃO é recusa comprovada: nenhum botão, e a tela diz que exige gente", () => {
    expect(
      atosDaRepublicacao({
        podeRepublicar: true,
        operacao: { status: "RELIST_FAILED", retomavel: false, failureReason: null },
        aguardandoWorker: false,
      }),
    ).toEqual({ pedir: false, executar: false, retomar: false, falha: "exige-gente", bloqueio: null });
  });

  it("quem não pode republicar vê a explicação da recusa, mas não o botão", () => {
    expect(
      atosDaRepublicacao({
        podeRepublicar: false,
        operacao: { status: "RELIST_FAILED", retomavel: true, failureReason: null },
        aguardandoWorker: false,
      }),
    ).toEqual({ pedir: false, executar: false, retomar: false, falha: "recusada", bloqueio: null });
  });

  it("depois de enviar a retomada, nada é oferecido até o worker mudar a operação (D-360)", () => {
    expect(
      atosDaRepublicacao({
        podeRepublicar: true,
        operacao: { status: "RELIST_FAILED", retomavel: true, failureReason: null },
        aguardandoWorker: true,
      }),
    ).toEqual({ pedir: false, executar: false, retomar: false, falha: null, bloqueio: null });
  });

  it("os atos de antes continuam: sem operação ou reprovada, pedir; REQUESTED, executar; viva, nada", () => {
    const semOperacao = atosDaRepublicacao({ podeRepublicar: true, operacao: null, aguardandoWorker: false });
    expect(semOperacao).toEqual({ pedir: true, executar: false, retomar: false, falha: null, bloqueio: null });

    for (const status of ["PREFLIGHT_FAILED", "CLOSE_FAILED"]) {
      expect(
        atosDaRepublicacao({
          podeRepublicar: true,
          operacao: { status, retomavel: false, failureReason: null },
          aguardandoWorker: false,
        }).pedir,
      ).toBe(true);
    }

    expect(
      atosDaRepublicacao({
        podeRepublicar: true,
        operacao: { status: "REQUESTED", retomavel: false, failureReason: null },
        aguardandoWorker: false,
      }),
    ).toEqual({ pedir: false, executar: true, retomar: false, falha: null, bloqueio: null });

    for (const status of ["CLOSING", "CLOSED", "RELISTING", "RELISTED", "REMAPPED"]) {
      expect(
        atosDaRepublicacao({
          podeRepublicar: true,
          operacao: { status, retomavel: true, failureReason: null },
          aguardandoWorker: false,
        }),
      ).toEqual({ pedir: false, executar: false, retomar: false, falha: null, bloqueio: null });
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
          aguardandoWorker: false,
        }),
      ).toEqual({ pedir: false, executar: false, retomar: false, falha: "nao-permitida", bloqueio: null });
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
        aguardandoWorker: false,
      }),
    ).toEqual({ pedir: false, executar: false, retomar: true, falha: "recusada", bloqueio: null });
  });

  it("pedido reprovado pelo preflight com VARIACOES_USER_PRODUCT: mostra a descrição do bloqueio e nunca oferece executar", () => {
    const preflight = evaluateRelistPreflight({
      tags: [],
      catalog_listing: false,
      listing_type_id: "gold_special",
      available_quantity: 698,
      variations: [{ id: 52_844_432_013, price: 114.9, available_quantity: 698, user_product_id: "MLBU1406603522" }],
    });
    // O `failure_reason` que o worker grava: as descrições dos bloqueios, juntas.
    const failureReason = preflight.blocks.map((block) => block.descricao).join(" ");

    const atos = atosDaRepublicacao({
      podeRepublicar: true,
      operacao: { status: "PREFLIGHT_FAILED", retomavel: false, failureReason },
      aguardandoWorker: false,
    });

    expect(atos.executar).toBe(false);
    expect(atos.retomar).toBe(false);
    expect(atos.bloqueio).toBe(preflight.blocks[0]?.descricao);
    expect(atos.bloqueio).toContain("não permite republicar anúncio com variações de conta no modelo de user products");

    // Outro bloqueio de preflight não ganha a descrição de D-369.
    expect(
      atosDaRepublicacao({
        podeRepublicar: true,
        operacao: { status: "PREFLIGHT_FAILED", retomavel: false, failureReason: "O anúncio está sem estoque." },
        aguardandoWorker: false,
      }).bloqueio,
    ).toBeNull();
  });
});
