import { describe, expect, it } from "vitest";

import {
  autorizacaoTikTokVencendo,
  autorizacaoVencendo,
  celulasDeContasELojas,
  isTikTokSchemaMissing,
  lojaRequerAtencao,
  lojaTikTokRequerAtencao,
  rotuloTipoVendedorTikTok,
  type LojaShopeeDaFaixa,
  type LojaTikTokDaFaixa,
} from "./contas-e-lojas";

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

  it("D-822 (M04): inclui lojas TikTok Shop na faixa quando presentes, preserva texto com lista vazia e sinaliza falha de leitura sem fingir zero", () => {
    const shopee = [loja()];
    const semTikTok = celulasDeContasELojas(contas, shopee, AGORA, []).map((c) => [c.label, c.value, c.ressalva ?? null]);

    expect(semTikTok[0]).toEqual(["Contas e lojas cadastradas", "6", "5 do Mercado Livre · 1 da Shopee"]);

    const tiktok: LojaTikTokDaFaixa[] = [
      { status: "CONNECTED", auth_expires_at: emDias(60) },
      { status: "CONNECTED", auth_expires_at: emDias(15) },
      { status: "ERROR", auth_expires_at: null },
    ];
    const comTikTok = celulasDeContasELojas(contas, shopee, AGORA, tiktok).map((c) => [
      c.label,
      c.value,
      c.ressalva ?? null,
    ]);

    expect(comTikTok).toEqual([
      ["Contas e lojas cadastradas", "9", "5 do Mercado Livre · 1 da Shopee · 3 do TikTok Shop"],
      ["Conectadas", "5", "2 do Mercado Livre · 1 da Shopee · 2 do TikTok Shop"],
      ["Aguardando conexão", "1", null],
      ["Requerem atenção", "4", "2 do Mercado Livre · 0 da Shopee · 2 do TikTok Shop"],
    ]);

    const erroTikTok = celulasDeContasELojas(contas, shopee, AGORA, null).map((c) => [
      c.label,
      c.value,
      c.ressalva ?? null,
    ]);

    expect(erroTikTok[0]).toEqual([
      "Contas e lojas cadastradas",
      "6",
      "5 do Mercado Livre · 1 da Shopee · as lojas TikTok não carregaram",
    ]);
  });
});

describe("TikTok Shop helpers (D-822 / M04)", () => {
  it("avisa a 30 dias do vencimento no TikTok Shop e classifica atenção, schema ausente e tipo de vendedor", () => {
    expect(autorizacaoTikTokVencendo({ status: "CONNECTED", auth_expires_at: emDias(31) }, AGORA)).toBe(false);
    expect(autorizacaoTikTokVencendo({ status: "CONNECTED", auth_expires_at: emDias(30) }, AGORA)).toBe(true);
    expect(autorizacaoTikTokVencendo({ status: "CONNECTED", auth_expires_at: null }, AGORA)).toBe(false);
    expect(autorizacaoTikTokVencendo({ status: "CONNECTED", auth_expires_at: "invalida" }, AGORA)).toBe(false);

    expect(lojaTikTokRequerAtencao({ status: "ERROR", auth_expires_at: null }, AGORA)).toBe(true);
    expect(lojaTikTokRequerAtencao({ status: "CONNECTED", auth_expires_at: emDias(10) }, AGORA)).toBe(true);
    expect(lojaTikTokRequerAtencao({ status: "CONNECTED", auth_expires_at: emDias(90) }, AGORA)).toBe(false);

    expect(isTikTokSchemaMissing({ code: "PGRST205" })).toBe(true);
    expect(isTikTokSchemaMissing({ code: "42P01" })).toBe(true);
    expect(isTikTokSchemaMissing({ code: "42501" })).toBe(false);
    expect(isTikTokSchemaMissing(null)).toBe(false);

    expect(rotuloTipoVendedorTikTok("LOCAL")).toBe("Nacional");
    expect(rotuloTipoVendedorTikTok("CROSS_BORDER")).toBe("Internacional");
    expect(rotuloTipoVendedorTikTok(null)).toBe("—");
  });
});
