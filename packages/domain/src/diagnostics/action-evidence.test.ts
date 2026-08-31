import { describe, expect, it } from "vitest";

import { describeActionEvidence } from "./action-evidence.js";

/** Forma real gravada por `detect-sales-anomaly-actions.ts` (D-064). */
const VENDA_ANOMALA = {
  direcao: "queda",
  z_score: -2.7,
  units_delta: -14,
  evidencias: [{ tipo: "venda_vs_baseline", descricao: "Vendeu 14 unidades a menos que o esperado." }],
  causas_candidatas: [
    {
      event_type: "stock.depleted",
      occurred_at: "2026-08-26T10:00:00.000Z",
      descricao: "Estoque zerou dois dias antes.",
    },
  ],
};

/** Forma real gravada por `detect-support-pattern-actions.ts` (D-116). */
const RECLAMACOES = {
  evidencias: [
    { tipo: "reclamacoes_abertas", descricao: "3 reclamações abertas simultaneamente no SKU 5821." },
    { tipo: "mediacoes", descricao: "1 delas já em mediação com o Mercado Livre." },
  ],
  reclamacoes_abertas: 3,
};

describe("describeActionEvidence", () => {
  it("republicação (D-164) tem rótulo próprio e tom NEUTRO — registro de ato, não problema nem oportunidade", () => {
    const view = describeActionEvidence("republicacao", {
      evidencias: [{ tipo: "republicacao", descricao: "MLB1 republicado como MLB2." }],
    });

    expect(view.kindLabel).toBe("Republicação");
    expect(view.tone).toBe("neutro");
    expect(view.direcaoLabel).toBeNull();
  });

  it("lê a anomalia de venda por completo", () => {
    const view = describeActionEvidence("venda_anomala", VENDA_ANOMALA);

    expect(view.kindLabel).toBe("Venda anômala");
    expect(view.direcaoLabel).toBe("Queda");
    expect(view.tone).toBe("problema");
    expect(view.evidencias).toHaveLength(1);
    expect(view.causas[0]?.eventType).toBe("stock.depleted");
  });

  it("alta vira oportunidade, não problema", () => {
    const view = describeActionEvidence("venda_anomala", { ...VENDA_ANOMALA, direcao: "alta" });

    expect(view.direcaoLabel).toBe("Alta");
    expect(view.tone).toBe("oportunidade");
  });

  it("padrão de reclamações NÃO quebra e NÃO inventa direção", () => {
    // O defeito original: a tela lia `causas_candidatas.length` num payload
    // que nunca teve o campo, derrubando a rota inteira na primeira ação de
    // SAC — e mostrava "Alta" por omissão, dizendo que a venda subiu.
    const view = describeActionEvidence("reclamacoes_recorrentes", RECLAMACOES);

    expect(view.kindLabel).toBe("Reclamações recorrentes");
    expect(view.direcaoLabel).toBeNull();
    expect(view.tone).toBe("problema");
    expect(view.evidencias).toHaveLength(2);
    expect(view.causas).toEqual([]);
  });

  it("um kind novo do worker degrada, nunca quebra", () => {
    const view = describeActionEvidence("ruptura_prevista", { evidencias: [] });

    expect(view.kindLabel).toBe("ruptura_prevista");
    expect(view.direcaoLabel).toBeNull();
    expect(view.tone).toBe("neutro");
  });

  it("payload corrompido, nulo ou de outro formato não lança", () => {
    for (const raw of [null, undefined, 42, "texto", [], {}, { evidencias: "não é lista" }]) {
      const view = describeActionEvidence("venda_anomala", raw);

      expect(view.evidencias).toEqual([]);
      expect(view.causas).toEqual([]);
      expect(view.direcaoLabel).toBeNull();
    }
  });

  it("descarta entradas malformadas sem descartar as boas", () => {
    const view = describeActionEvidence("venda_anomala", {
      evidencias: [{ descricao: "vale" }, null, { tipo: "sem_descricao" }, "texto solto"],
      causas_candidatas: [{ descricao: "causa vale" }, 7],
    });

    expect(view.evidencias).toEqual([{ tipo: "evidencia", descricao: "vale" }]);
    expect(view.causas).toHaveLength(1);
    expect(view.causas[0]?.eventType).toBe("desconhecido");
  });

  it("direção fora do vocabulário é tratada como ausente", () => {
    const view = describeActionEvidence("venda_anomala", { ...VENDA_ANOMALA, direcao: "estavel" });

    expect(view.direcaoLabel).toBeNull();
    expect(view.tone).toBe("neutro");
  });
});
