import { describe, expect, it } from "vitest";

import { summarizeRelistVariations } from "@sb/domain";

import {
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
        operacao: { status: "RELIST_FAILED", retomavel: true },
        aguardandoWorker: false,
      }),
    ).toEqual({ pedir: false, executar: false, retomar: true, falha: "recusada" });
  });

  it("RELIST_FAILED que NÃO é recusa comprovada: nenhum botão, e a tela diz que exige gente", () => {
    expect(
      atosDaRepublicacao({
        podeRepublicar: true,
        operacao: { status: "RELIST_FAILED", retomavel: false },
        aguardandoWorker: false,
      }),
    ).toEqual({ pedir: false, executar: false, retomar: false, falha: "exige-gente" });
  });

  it("quem não pode republicar vê a explicação da recusa, mas não o botão", () => {
    expect(
      atosDaRepublicacao({
        podeRepublicar: false,
        operacao: { status: "RELIST_FAILED", retomavel: true },
        aguardandoWorker: false,
      }),
    ).toEqual({ pedir: false, executar: false, retomar: false, falha: "recusada" });
  });

  it("depois de enviar a retomada, nada é oferecido até o worker mudar a operação (D-360)", () => {
    expect(
      atosDaRepublicacao({
        podeRepublicar: true,
        operacao: { status: "RELIST_FAILED", retomavel: true },
        aguardandoWorker: true,
      }),
    ).toEqual({ pedir: false, executar: false, retomar: false, falha: null });
  });

  it("os atos de antes continuam: sem operação ou reprovada, pedir; REQUESTED, executar; viva, nada", () => {
    const semOperacao = atosDaRepublicacao({ podeRepublicar: true, operacao: null, aguardandoWorker: false });
    expect(semOperacao).toEqual({ pedir: true, executar: false, retomar: false, falha: null });

    for (const status of ["PREFLIGHT_FAILED", "CLOSE_FAILED"]) {
      expect(
        atosDaRepublicacao({ podeRepublicar: true, operacao: { status, retomavel: false }, aguardandoWorker: false }).pedir,
      ).toBe(true);
    }

    expect(
      atosDaRepublicacao({ podeRepublicar: true, operacao: { status: "REQUESTED", retomavel: false }, aguardandoWorker: false }),
    ).toEqual({ pedir: false, executar: true, retomar: false, falha: null });

    for (const status of ["CLOSING", "CLOSED", "RELISTING", "RELISTED", "REMAPPED"]) {
      expect(
        atosDaRepublicacao({ podeRepublicar: true, operacao: { status, retomavel: true }, aguardandoWorker: false }),
      ).toEqual({ pedir: false, executar: false, retomar: false, falha: null });
    }
  });
});
