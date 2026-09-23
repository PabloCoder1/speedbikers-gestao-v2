import { describe, expect, it } from "vitest";

import { resolverPeriodoCentral } from "./central-periodo";

const HOJE = "2026-09-23";

describe("resolverPeriodoCentral", () => {
  it("sem parâmetro usa os últimos 30 dias COMPLETOS, terminando ontem", () => {
    const p = resolverPeriodoCentral({}, HOJE);

    expect(p.preset).toBe("30d");
    expect(p.atual).toEqual({ from: "2026-08-24", to: "2026-09-22" });
    expect(p.anterior).toEqual({ from: "2026-07-25", to: "2026-08-23" });
    expect(p.emAndamento).toBe(false);
  });

  it("hoje compara com ontem e fica marcado como em andamento", () => {
    const p = resolverPeriodoCentral({ p: "hoje" }, HOJE);

    expect(p.atual).toEqual({ from: HOJE, to: HOJE });
    expect(p.anterior).toEqual({ from: "2026-09-22", to: "2026-09-22" });
    expect(p.emAndamento).toBe(true);
  });

  it("ontem compara com anteontem, os dois dias inteiros", () => {
    const p = resolverPeriodoCentral({ p: "ontem" }, HOJE);

    expect(p.atual).toEqual({ from: "2026-09-22", to: "2026-09-22" });
    expect(p.anterior).toEqual({ from: "2026-09-21", to: "2026-09-21" });
    expect(p.emAndamento).toBe(false);
  });

  it("7 dias: a semana até ontem contra a semana anterior", () => {
    const p = resolverPeriodoCentral({ p: "7d" }, HOJE);

    expect(p.atual).toEqual({ from: "2026-09-16", to: "2026-09-22" });
    expect(p.anterior).toEqual({ from: "2026-09-09", to: "2026-09-15" });
  });

  it("mês atual: do dia 1 até ontem, contra os mesmos dias do mês anterior", () => {
    const p = resolverPeriodoCentral({ p: "mes" }, HOJE);

    expect(p.atual).toEqual({ from: "2026-09-01", to: "2026-09-22" });
    expect(p.anterior).toEqual({ from: "2026-08-01", to: "2026-08-22" });
  });

  it("mês atual no fim de março limita a comparação ao fim de fevereiro", () => {
    const p = resolverPeriodoCentral({ p: "mes" }, "2026-03-31");

    expect(p.atual).toEqual({ from: "2026-03-01", to: "2026-03-30" });
    expect(p.anterior).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("mês atual no dia 1 é o próprio dia, em andamento, contra o dia 1 do mês anterior", () => {
    const p = resolverPeriodoCentral({ p: "mes" }, "2026-10-01");

    expect(p.atual).toEqual({ from: "2026-10-01", to: "2026-10-01" });
    expect(p.anterior).toEqual({ from: "2026-09-01", to: "2026-09-01" });
    expect(p.emAndamento).toBe(true);
  });

  it("mês anterior inteiro contra o mês antes dele, atravessando o ano", () => {
    expect(resolverPeriodoCentral({ p: "mes-anterior" }, HOJE)).toMatchObject({
      atual: { from: "2026-08-01", to: "2026-08-31" },
      anterior: { from: "2026-07-01", to: "2026-07-31" },
    });
    expect(resolverPeriodoCentral({ p: "mes-anterior" }, "2026-01-15")).toMatchObject({
      atual: { from: "2025-12-01", to: "2025-12-31" },
      anterior: { from: "2025-11-01", to: "2025-11-30" },
    });
  });

  it("personalizado vence o preset, corta o fim em hoje e compara com a janela anterior de mesmo tamanho", () => {
    const p = resolverPeriodoCentral({ p: "7d", from: "2026-09-20", to: "2026-09-30" }, HOJE);

    expect(p.preset).toBeNull();
    expect(p.atual).toEqual({ from: "2026-09-20", to: HOJE });
    expect(p.anterior).toEqual({ from: "2026-09-16", to: "2026-09-19" });
    expect(p.emAndamento).toBe(true);
    expect(p.invalido).toBe(false);
  });

  it("personalizado inválido cai no padrão e avisa", () => {
    for (const query of [{ from: "2026-09-10" }, { from: "2026-09-10", to: "2026-09-01" }, { from: "2026-10-01", to: "2026-10-05" }, { from: "ontem", to: "hoje" }]) {
      const p = resolverPeriodoCentral(query, HOJE);

      expect(p.invalido).toBe(true);
      expect(p.preset).toBe("30d");
    }
  });

  it("preset desconhecido cai no padrão sem aviso de personalizado", () => {
    const p = resolverPeriodoCentral({ p: "90d" }, HOJE);

    expect(p.preset).toBe("30d");
    expect(p.invalido).toBe(false);
  });
});
