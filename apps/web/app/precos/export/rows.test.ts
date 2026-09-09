import { describe, expect, it } from "vitest";

import {
  buildPriceExportRows,
  describePriceExportFilters,
  toSpreadsheetInstant,
  type PriceChangeExportInput,
} from "./rows";

/**
 * O conteúdo da planilha de `/precos` (D-292).
 *
 * O que estes casos protegem não é formatação: é a diferença entre **ausência
 * e zero** dentro de um arquivo que sai do sistema e vai ser somado por
 * alguém. Na tela, um "—" no lugar de 0% é corrigível na hora seguinte; numa
 * planilha ele vira média errada num relatório que ninguém mais confere.
 */

const BASE: PriceChangeExportInput = {
  occurred_at: "2026-09-01T12:00:00Z",
  title: "Pneu 29",
  sku: "SB-001",
  item_id: "MLB123",
  status: "active",
  account_label: "Loja A",
  price_before: 100,
  price_after: 120,
  delta: 20,
  delta_ratio: 0.2,
};

const rotulo = (code: string): string => (code === "active" ? "Ativo" : code);

describe("buildPriceExportRows", () => {
  it("leva SKU e MLB como TEXTO — é por eles que a planilha se cruza com o resto", () => {
    const [linha] = buildPriceExportRows([BASE], rotulo);

    expect(linha?.sku).toBe("SB-001");
    expect(linha?.itemId).toBe("MLB123");
    expect(linha?.status).toBe("Ativo");
  });

  it("número sai como NÚMERO, não como texto formatado", () => {
    const [linha] = buildPriceExportRows([BASE], rotulo);

    expect(linha?.priceBefore).toBe(100);
    expect(linha?.delta).toBe(20);
    // Fração, não porcentagem: quem multiplica é o `numFmt` da célula.
    expect(linha?.deltaRatio).toBe(0.2);
  });

  it("ausência é NOMEADA, nunca vazio nem zero (D-067)", () => {
    const [linha] = buildPriceExportRows(
      [{ ...BASE, title: null, sku: null, status: null, delta_ratio: null }],
      rotulo,
    );

    expect(linha?.title).toBe("anúncio fora do catálogo");
    expect(linha?.sku).toBe("sem vínculo");
    expect(linha?.status).toBe("—");
    // O caso que importa: preço anterior zero não tem variação percentual
    // definida, e 0% seria resposta errada com cara de precisa.
    expect(linha?.deltaRatio).toBeNull();
  });

  it("a direção sai do sinal do delta, como a coluna da tela", () => {
    const linhas = buildPriceExportRows([BASE, { ...BASE, delta: -5, price_after: 95 }], rotulo);

    expect(linhas[0]?.direction).toBe("AUMENTO");
    expect(linhas[1]?.direction).toBe("REDUÇÃO");
  });
});

describe("describePriceExportFilters", () => {
  const formatDay = (day: string): string => day.split("-").reverse().join("/");
  const directionLabel = (code: string): string => (code === "down" ? "Reduções" : "Aumentos");

  it("descreve o recorte inteiro — é o que dá contexto ao arquivo solto", () => {
    expect(
      describePriceExportFilters({
        dayFrom: "2026-09-01",
        dayTo: "2026-09-09",
        accountLabel: "Loja A",
        direction: "down",
        search: "pneu",
        formatDay,
        directionLabel,
      }),
    ).toBe('De 01/09/2026 a 09/09/2026 · Conta: Loja A · Só reduções · Busca: "pneu"');
  });

  it("sem filtro, diz o que o padrão significa — nunca omite a dimensão", () => {
    expect(
      describePriceExportFilters({
        dayFrom: "2026-08-11",
        dayTo: null,
        accountLabel: null,
        direction: null,
        search: null,
        formatDay,
        directionLabel,
      }),
    ).toBe("De 11/08/2026 até hoje · Todas as contas");
  });
});

/**
 * O defeito que só a inspeção do arquivo gerado pegou: o XLSX guarda relógio
 * de parede, sem fuso, e a mesma alteração aparecia às 17:52 na tela e às
 * 20:52 na planilha.
 */
describe("toSpreadsheetInstant", () => {
  it("converte para o relógio de São Paulo, que é o que a tela mostra", () => {
    // 20:52 UTC = 17:52 em São Paulo (UTC-3).
    expect(toSpreadsheetInstant("2026-09-08T20:52:20Z").toISOString()).toBe("2026-09-08T17:52:20.000Z");
  });

  it("atravessa a virada do dia sem inventar data", () => {
    // 01:30 UTC do dia 9 ainda é 22:30 do dia 8 em São Paulo — o mesmo caso
    // que o teste de vendas usa para o dia civil.
    expect(toSpreadsheetInstant("2026-09-09T01:30:00Z").toISOString()).toBe("2026-09-08T22:30:00.000Z");
  });
});
