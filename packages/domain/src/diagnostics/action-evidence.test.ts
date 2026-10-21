import { describe, expect, it } from "vitest";

import { describeActionEvidence, readShopeeListingRef } from "./action-evidence.js";

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

  it("os alertas da central (D-403) são problema, com rótulo e a evidência escrita no banco", () => {
    const evidencia = {
      nivel: "forte",
      evidencias: [
        { tipo: "frete_atual", descricao: "Frete médio de R$ 35,00 nos últimos 14 dias até 31/05/2023." },
        { tipo: "historico", descricao: "Pelo histórico do próprio anúncio, o esperado seria R$ 15,00." },
      ],
      detector: { anuncio: "MLB9700031" },
    };

    for (const [kind, rotulo] of [
      ["frete_anomalo", "Frete anômalo"],
      ["ads_campanha", "Campanha de Ads"],
      ["produto_prejuizo", "Produto no prejuízo"],
    ] as const) {
      const view = describeActionEvidence(kind, evidencia);

      expect(view.kindLabel).toBe(rotulo);
      expect(view.tone).toBe("problema");
      expect(view.direcaoLabel).toBeNull();
      expect(view.evidencias.map((e) => e.tipo)).toEqual(["frete_atual", "historico"]);
    }
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

/** A forma que a `sincronizar_alertas_central` grava nos detectores da Shopee (D-609, D-611). */
const SHOPEE_SEM_VINCULO = {
  evidencias: [
    { tipo: "venda", descricao: "De 20/09/2026 a 19/10/2026: 3 unidades em 3 pedidos, R$ 300,00 de receita, na loja X, sem SKU vinculado." },
    { tipo: "vinculo", descricao: "O anúncio não traz SKU e não tem vínculo manual." },
  ],
  detector: { shopee_shop_id: "loja-1", item_id: 990777001, model_id: null, sku_anuncio: null, estado: "SEM_SKU_NO_ANUNCIO" },
};

describe("os detectores da Shopee (D-626)", () => {
  it("têm rótulo próprio, são problema e mostram a evidência escrita no banco", () => {
    for (const [kind, rotulo] of [
      ["shopee_sem_vinculo", "Shopee vendendo sem vínculo"],
      ["shopee_ruptura", "Ruptura no anúncio da Shopee"],
    ] as const) {
      const view = describeActionEvidence(kind, SHOPEE_SEM_VINCULO);

      expect(view.kindLabel).toBe(rotulo);
      expect(view.tone).toBe("problema");
      expect(view.evidencias).toHaveLength(2);
    }
  });
});

describe("readShopeeListingRef (D-626)", () => {
  it("o SKU do anúncio é a busca; sem ele, o número do item", () => {
    expect(readShopeeListingRef({ detector: { shopee_shop_id: "loja-1", sku_anuncio: " CAP-01 ", item_id: 7 } })).toEqual({
      lojaId: "loja-1",
      busca: "CAP-01",
      anuncio: null,
    });
    expect(readShopeeListingRef(SHOPEE_SEM_VINCULO)).toEqual({ lojaId: "loja-1", busca: "990777001", anuncio: null });
    expect(readShopeeListingRef({ detector: { shopee_shop_id: "l", item_id: 1, anuncio: "Capacete", variacao: "Preto" } })?.anuncio).toBe("Capacete · Preto");
    expect(readShopeeListingRef({ detector: { shopee_shop_id: "loja-1", sku_anuncio: "", item_id: "42" } })).toEqual({
      lojaId: "loja-1",
      busca: "42",
      anuncio: null,
    });
  });

  it("sem a loja, sem busca possível ou com forma estranha, não há atalho", () => {
    expect(readShopeeListingRef({ detector: { sku_anuncio: "CAP-01" } })).toBeNull();
    expect(readShopeeListingRef({ detector: { shopee_shop_id: "loja-1", item_id: -1 } })).toBeNull();
    expect(readShopeeListingRef({ detector: { shopee_shop_id: "loja-1", item_id: "12a" } })).toBeNull();
    expect(readShopeeListingRef({ detector: "texto" })).toBeNull();
    expect(readShopeeListingRef(null)).toBeNull();
    expect(readShopeeListingRef({ evidencias: [] })).toBeNull();
  });
});
