import { describe, expect, it } from "vitest";

import { nfeEtapas } from "./nfe-steps.js";

/**
 * As etapas da NF-e (D-277). O que estes casos protegem não é o desenho: é a
 * recusa a mostrar progresso que o sistema não mede — e o lugar certo da
 * falha, que só `parsed_at` sabe dizer.
 */
describe("etapas do processo de NF-e (D-277)", () => {
  const base = { parsedAt: null, totalItems: 3, resolvedItems: 0 };

  it("são QUATRO etapas, uma por estado real — nunca as seis do frame", () => {
    const etapas = nfeEtapas({ ...base, status: "PARSED", parsedAt: "2026-09-05T10:00:00Z" });

    expect(etapas.map((e) => e.label)).toEqual([
      "Upload do XML",
      "Leitura do arquivo",
      "Conferência e vínculo",
      "Entrada no estoque",
    ]);
  });

  it("UPLOADED: a leitura está na fila, e diz isso", () => {
    const etapas = nfeEtapas({ ...base, status: "UPLOADED" });

    expect(etapas[1]).toEqual({ label: "Leitura do arquivo", estado: "atual", nota: "na fila" });
    expect(etapas[2]?.estado).toBe("pendente");
  });

  it("PARSING é distinguido de UPLOADED pela nota — os dois são a mesma etapa", () => {
    expect(nfeEtapas({ ...base, status: "PARSING" })[1]?.nota).toBe("em andamento");
  });

  it("PARSED: a conferência é a etapa atual e carrega a FRAÇÃO, o único progresso mensurável ali", () => {
    const etapas = nfeEtapas({
      status: "PARSED",
      parsedAt: "2026-09-05T10:00:00Z",
      totalItems: 3,
      resolvedItems: 1,
    });

    expect(etapas[1]?.estado).toBe("concluida");
    expect(etapas[2]).toEqual({
      label: "Conferência e vínculo",
      estado: "atual",
      nota: "1 de 3 vinculados",
    });
    expect(etapas[3]?.estado).toBe("pendente");
  });

  it("APPLIED: tudo concluído, e o singular flexiona", () => {
    const etapas = nfeEtapas({
      status: "APPLIED",
      parsedAt: "2026-09-05T10:00:00Z",
      totalItems: 1,
      resolvedItems: 1,
    });

    expect(etapas.every((e) => e.estado === "concluida")).toBe(true);
    expect(etapas[2]?.nota).toBe("1 item vinculado");
  });

  it("FAILED SEM parsed_at falha na LEITURA — e as etapas seguintes não fingem caminho feliz", () => {
    const etapas = nfeEtapas({ ...base, status: "FAILED" });

    expect(etapas[1]?.estado).toBe("falhou");
    expect(etapas[2]?.estado).toBe("pendente");
    expect(etapas[3]?.estado).toBe("pendente");
  });

  it("FAILED COM parsed_at falha na APLICAÇÃO — o mesmo status, outro lugar", () => {
    const etapas = nfeEtapas({
      status: "FAILED",
      parsedAt: "2026-09-05T10:00:00Z",
      totalItems: 3,
      resolvedItems: 3,
    });

    expect(etapas[1]?.estado).toBe("concluida");
    expect(etapas[2]?.estado).toBe("concluida");
    expect(etapas[3]?.estado).toBe("falhou");
  });

  it("CANCELLED não tem etapa ATUAL, e diz ONDE parou", () => {
    const etapas = nfeEtapas({
      status: "CANCELLED",
      parsedAt: "2026-09-05T10:00:00Z",
      totalItems: 3,
      resolvedItems: 1,
    });

    expect(etapas.some((e) => e.estado === "atual")).toBe(false);
    // "pendente" apagaria o lugar da parada; "cancelada" o preserva.
    expect(etapas[2]?.estado).toBe("cancelada");
    expect(etapas[3]?.estado).toBe("pendente");
  });

  it("itens nulos não viram NaN na nota — documento ainda sem parse tem contagem indefinida", () => {
    const etapas = nfeEtapas({
      status: "PARSED",
      parsedAt: "2026-09-05T10:00:00Z",
      totalItems: null,
      resolvedItems: null,
    });

    expect(etapas[2]?.nota).toBe("0 de 0 vinculados");
  });
});
