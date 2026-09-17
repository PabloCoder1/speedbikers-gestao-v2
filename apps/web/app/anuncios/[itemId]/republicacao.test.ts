import { describe, expect, it } from "vitest";

import { atosDaRepublicacao } from "./republicacao";

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
