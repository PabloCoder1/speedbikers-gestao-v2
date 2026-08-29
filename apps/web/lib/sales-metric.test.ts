import { describe, expect, it } from "vitest";

import { DEFAULT_SALES_METRIC, SALES_METRICS, resolveSalesMetric } from "./sales-metric";

describe("resolveSalesMetric", () => {
  it("resolve cada uma das quatro chaves", () => {
    expect(resolveSalesMetric("faturamento").field).toBe("gross_revenue");
    expect(resolveSalesMetric("unidades").field).toBe("units_sold");
    expect(resolveSalesMetric("pedidos").field).toBe("orders_count");
    expect(resolveSalesMetric("packs").field).toBe("purchases_count");
  });

  /**
   * A trava que protege links antigos. Uma URL sem `?metric=` existe desde
   * 2026-08-21 e tem de continuar mostrando faturamento — trocar o default
   * mudaria em silêncio o que a tela mostra para quem abre `/vendas` direto,
   * que é o caminho mais comum.
   */
  it("URL sem parâmetro continua em faturamento — o comportamento anterior à fatia", () => {
    expect(resolveSalesMetric(undefined)).toBe(DEFAULT_SALES_METRIC);
    expect(DEFAULT_SALES_METRIC.key).toBe("faturamento");
    expect(DEFAULT_SALES_METRIC.field).toBe("gross_revenue");
  });

  it("valor desconhecido, vazio ou não-string cai no default sem lançar", () => {
    expect(resolveSalesMetric("receita_liquida")).toBe(DEFAULT_SALES_METRIC);
    expect(resolveSalesMetric("")).toBe(DEFAULT_SALES_METRIC);
    expect(resolveSalesMetric(null)).toBe(DEFAULT_SALES_METRIC);
    expect(resolveSalesMetric(42)).toBe(DEFAULT_SALES_METRIC);
    // Array é o que `searchParams` entrega quando o parâmetro vem repetido
    // (`?metric=a&metric=b`) — o tipo da página é `string | string[]`.
    expect(resolveSalesMetric(["unidades"])).toBe(DEFAULT_SALES_METRIC);
  });

  it("chaves e campos são únicos — duas entradas apontando para a mesma coluna seria bug silencioso", () => {
    expect(new Set(SALES_METRICS.map((m) => m.key)).size).toBe(SALES_METRICS.length);
    expect(new Set(SALES_METRICS.map((m) => m.field)).size).toBe(SALES_METRICS.length);
  });

  /**
   * `docs/ARCHITECTURE.md` §15 exige que todo número na tela carregue o ID da
   * sua definição. Se alguém acrescentar uma quinta métrica sem definição no
   * catálogo, este teste falha antes de a tela mentir sobre a origem do
   * número. Os quatro IDs vêm de `docs/METRICS.md` 5.2, aprovados em
   * 2026-08-21 — nenhum foi inventado nesta fatia.
   */
  it("toda métrica carrega um ID do catálogo de docs/METRICS.md 5.2", () => {
    const aprovados = new Set(["receita_bruta", "unidades_vendidas", "pedidos", "pedidos_por_pack"]);

    for (const metric of SALES_METRICS) {
      expect(aprovados.has(metric.definitionId)).toBe(true);
    }
  });

  it("só faturamento é moeda — contagem formatada como moeda inventaria R$ em unidade vendida", () => {
    expect(SALES_METRICS.filter((m) => m.format === "currency").map((m) => m.key)).toEqual(["faturamento"]);
  });
});
