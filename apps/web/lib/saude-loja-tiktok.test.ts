import { describe, expect, it } from "vitest";

import { avisoDaAutorizacaoTikTok, vereditoDaLojaTikTok, type LojaTikTokSaude } from "./saude-loja-tiktok";

const AGORA = new Date("2026-11-24T12:00:00.000Z");
const emDias = (dias: number): string => new Date(AGORA.getTime() + dias * 86_400_000).toISOString();

const loja = (parcial: Partial<LojaTikTokSaude> = {}): LojaTikTokSaude => ({
  status: "CONNECTED",
  auth_expires_at: emDias(90),
  ...parcial,
});

describe("saude-loja-tiktok (D-824 / M04)", () => {
  it("avisoDaAutorizacaoTikTok devolve null acima de 30 dias, sem data ou com data/now inválido", () => {
    expect(avisoDaAutorizacaoTikTok(loja({ auth_expires_at: emDias(31) }), AGORA)).toBeNull();
    expect(avisoDaAutorizacaoTikTok(loja({ auth_expires_at: null }), AGORA)).toBeNull();
    expect(avisoDaAutorizacaoTikTok(loja({ auth_expires_at: "invalida" }), AGORA)).toBeNull();
    expect(avisoDaAutorizacaoTikTok(loja({ auth_expires_at: emDias(10) }), new Date("invalida"))).toBeNull();
  });

  it("avisoDaAutorizacaoTikTok avisa em atenção até 30 dias e em perigo quando já venceu", () => {
    const vencendo = avisoDaAutorizacaoTikTok(loja({ auth_expires_at: emDias(10) }), AGORA);
    expect(vencendo?.tom).toBe("atencao");
    expect(vencendo?.rotulo).toContain("10 dia");

    const vencida = avisoDaAutorizacaoTikTok(loja({ auth_expires_at: emDias(-2) }), AGORA);
    expect(vencida?.tom).toBe("perigo");
    expect(vencida?.rotulo).toBe("Autorização vencida");
  });

  it("vereditoDaLojaTikTok nunca declara verde sem sync, aponta erro quando desconectada e atenção quando vencendo", () => {
    const conectada = vereditoDaLojaTikTok(loja(), AGORA);
    expect(conectada.tom).toBe("neutro");
    expect(conectada.rotulo).toContain("Conectada");

    const vencendo = vereditoDaLojaTikTok(loja({ auth_expires_at: emDias(5) }), AGORA);
    expect(vencendo.tom).toBe("atencao");

    const vencida = vereditoDaLojaTikTok(loja({ auth_expires_at: emDias(-1) }), AGORA);
    expect(vencida.tom).toBe("perigo");

    const erro = vereditoDaLojaTikTok(loja({ status: "ERROR" }), AGORA);
    expect(erro.tom).toBe("perigo");
    expect(erro.rotulo).toBe("Conexão em erro");
  });
});
