import { describe, expect, it } from "vitest";

import { autorizacaoVencendo, celulasDeContasELojas, lojaRequerAtencao, type LojaShopeeDaFaixa } from "./contas-e-lojas";

const AGORA = new Date("2026-10-19T12:00:00Z");
const emDias = (dias: number): string => new Date(AGORA.getTime() + dias * 86_400_000).toISOString();

const loja = (parcial: Partial<LojaShopeeDaFaixa> = {}): LojaShopeeDaFaixa => ({
  status: "CONNECTED",
  environment: "live",
  auth_expires_at: emDias(300),
  ...parcial,
});

const contas = [{ status: "CONNECTED" }, { status: "CONNECTED" }, { status: "PENDING" }, { status: "ERROR" }, { status: "REVOKED" }];

/** [rótulo, valor, ressalva] de cada célula. */
const resumo = (lojas: readonly LojaShopeeDaFaixa[] | null) =>
  celulasDeContasELojas(contas, lojas, AGORA).map((c) => [c.label, c.value, c.ressalva ?? null]);

describe("autorizacaoVencendo e lojaRequerAtencao", () => {
  it("avisa a 7 dias do vencimento e depois dele; sem data, não se sabe e não avisa", () => {
    expect(autorizacaoVencendo(loja({ auth_expires_at: emDias(8) }), AGORA)).toBe(false);
    expect(autorizacaoVencendo(loja({ auth_expires_at: emDias(7) }), AGORA)).toBe(true);
    expect(autorizacaoVencendo(loja({ auth_expires_at: emDias(-1) }), AGORA)).toBe(true);
    expect(autorizacaoVencendo(loja({ auth_expires_at: null }), AGORA)).toBe(false);
  });

  it("a loja com erro e a conectada com a autorização vencendo requerem atenção; a conectada em dia, não", () => {
    expect(lojaRequerAtencao(loja({ status: "ERROR" }), AGORA)).toBe(true);
    expect(lojaRequerAtencao(loja({ auth_expires_at: emDias(3) }), AGORA)).toBe(true);
    expect(lojaRequerAtencao(loja(), AGORA)).toBe(false);
  });
});

describe("celulasDeContasELojas (D-600)", () => {
  it("as quatro células contam contas e lojas, com a divisão dita ao lado do número", () => {
    const lojas = [loja(), loja({ auth_expires_at: emDias(2) }), loja({ status: "ERROR", environment: "sandbox" })];

    expect(resumo(lojas)).toEqual([
      ["Contas e lojas cadastradas", "8", "5 do Mercado Livre · 3 da Shopee (1 de teste)"],
      // A loja com a autorização vencendo está conectada E requer atenção: conta nas duas.
      ["Conectadas", "4", "2 do Mercado Livre · 2 da Shopee"],
      ["Aguardando conexão", "1", null],
      ["Requerem atenção", "4", "2 do Mercado Livre · 2 da Shopee"],
    ]);
  });

  it("sem loja Shopee, a divisão diz zero -- é fato, a leitura veio", () => {
    expect(resumo([])[0]).toEqual(["Contas e lojas cadastradas", "5", "5 do Mercado Livre · 0 da Shopee"]);
  });

  it("as lojas que não carregaram não viram zero: o número é só do ML, e a ressalva diz", () => {
    for (const [, , ressalva] of resumo(null).filter(([rotulo]) => rotulo !== "Aguardando conexão")) {
      expect(ressalva).toMatch(/as lojas Shopee não carregaram$/u);
    }

    expect(resumo(null)[0]?.[1]).toBe("5");
  });
});
