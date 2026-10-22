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

describe("o TikTok Shop na faixa (D-652, C-86)", () => {
  const tiktok = (lojas: readonly { status: string; auth_expires_at: string | null }[]) => ({ estado: "lidas" as const, lojas });
  const comTiktok = (estado: Parameters<typeof celulasDeContasELojas>[3]) =>
    celulasDeContasELojas(contas, [loja()], AGORA, estado).map((c) => [c.label, c.value, c.ressalva ?? null]);

  it("lidas, as lojas do TikTok somam e aparecem na divisão, com a mesma régua de atenção da Shopee", () => {
    expect(
      comTiktok(tiktok([{ status: "CONNECTED", auth_expires_at: emDias(200) }, { status: "CONNECTED", auth_expires_at: emDias(5) }, { status: "ERROR", auth_expires_at: null }])),
    ).toEqual([
      ["Contas e lojas cadastradas", "9", "5 do Mercado Livre · 1 da Shopee · 3 do TikTok Shop"],
      ["Conectadas", "5", "2 do Mercado Livre · 1 da Shopee · 2 do TikTok Shop"],
      ["Aguardando conexão", "1", null],
      ["Requerem atenção", "4", "2 do Mercado Livre · 0 da Shopee · 2 do TikTok Shop"],
    ]);
  });

  it("lida e vazia, a divisão diz zero -- é fato, como na Shopee", () => {
    expect(comTiktok(tiktok([]))[0]).toEqual(["Contas e lojas cadastradas", "6", "5 do Mercado Livre · 1 da Shopee · 0 do TikTok Shop"]);
  });

  it("a leitura falhou: não vira zero, a ressalva diz, e o número é o do que carregou", () => {
    const [cadastradas] = comTiktok({ estado: "falhou" });

    expect(cadastradas).toEqual(["Contas e lojas cadastradas", "6", "5 do Mercado Livre · 1 da Shopee · as lojas do TikTok Shop não carregaram"]);
  });

  it("sem a tabela (antes da migration), o TikTok fica fora da divisão -- e é o padrão de quem não passa nada", () => {
    expect(comTiktok({ estado: "ausente" })).toEqual(comTiktok(undefined));
    expect(comTiktok({ estado: "ausente" })[0]).toEqual(["Contas e lojas cadastradas", "6", "5 do Mercado Livre · 1 da Shopee"]);
  });

  it("as duas leituras falhando: as duas ressalvas, e o número só do ML", () => {
    const [cadastradas] = celulasDeContasELojas(contas, null, AGORA, { estado: "falhou" });

    expect(cadastradas?.value).toBe("5");
    expect(cadastradas?.ressalva).toBe("5 do Mercado Livre · as lojas Shopee não carregaram · as lojas do TikTok Shop não carregaram");
  });
});
