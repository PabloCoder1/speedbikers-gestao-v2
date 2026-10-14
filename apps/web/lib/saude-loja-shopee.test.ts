import { describe, expect, it } from "vitest";

import { avisoDaAutorizacao, lojaDeTeste, vereditoDaLoja, type LojaNaSaude } from "./saude-loja-shopee";

const AGORA = new Date("2026-10-14T15:00:00Z");

function horasAtras(h: number): string {
  return new Date(AGORA.getTime() - h * 3_600_000).toISOString();
}

function diasAdiante(d: number): string {
  return new Date(AGORA.getTime() + d * 86_400_000 + 60_000).toISOString();
}

const LOJA: LojaNaSaude = {
  connection_status: "CONNECTED",
  environment: "live",
  orders_synced_at: horasAtras(1),
  connected_at: horasAtras(24 * 30),
  authorization_expires_at: diasAdiante(200),
};

describe("vereditoDaLoja — os limiares do vigia (D-435)", () => {
  it("leitura terminada há menos de 3 h: em dia", () => {
    expect(vereditoDaLoja(LOJA, AGORA)).toMatchObject({ tom: "ok", rotulo: "Pedidos em dia" });
  });

  it("de 3 h a 12 h: atrasada, como o sync.delayed", () => {
    expect(vereditoDaLoja({ ...LOJA, orders_synced_at: horasAtras(3) }, AGORA)).toMatchObject({ tom: "atencao" });
    expect(vereditoDaLoja({ ...LOJA, orders_synced_at: horasAtras(11.9) }, AGORA).orientacao).toContain("há 11 h");
  });

  it("12 h ou mais: parada, como o sync.failed", () => {
    expect(vereditoDaLoja({ ...LOJA, orders_synced_at: horasAtras(12) }, AGORA)).toMatchObject({
      tom: "perigo",
      rotulo: "Pedidos parados",
    });
  });

  it("a conexão vence o frescor: loja em erro não é lida, por mais recente que tenha sido", () => {
    expect(vereditoDaLoja({ ...LOJA, connection_status: "ERROR" }, AGORA)).toMatchObject({
      tom: "perigo",
      rotulo: "Conexão em erro",
    });
  });

  it("nunca lida: a referência é a conexão, como no vigia — recém-conectada espera, antiga está parada", () => {
    expect(vereditoDaLoja({ ...LOJA, orders_synced_at: null, connected_at: horasAtras(1) }, AGORA)).toMatchObject({
      tom: "neutro",
      rotulo: "Primeira leitura",
    });
    expect(vereditoDaLoja({ ...LOJA, orders_synced_at: null, connected_at: horasAtras(20) }, AGORA)).toMatchObject({
      rotulo: "Pedidos parados",
    });
    expect(vereditoDaLoja({ ...LOJA, orders_synced_at: null, connected_at: null }, AGORA)).toMatchObject({
      rotulo: "Nunca lida",
    });
  });
});

describe("avisoDaAutorizacao", () => {
  it("longe do vencimento: nada a dizer", () => {
    expect(avisoDaAutorizacao(LOJA, AGORA)).toBeNull();
    expect(avisoDaAutorizacao({ ...LOJA, authorization_expires_at: null }, AGORA)).toBeNull();
  });

  it("até 30 dias: avisa quantos faltam", () => {
    expect(avisoDaAutorizacao({ ...LOJA, authorization_expires_at: diasAdiante(30) }, AGORA)).toMatchObject({
      tom: "atencao",
      rotulo: "Autorização vence em 30 dias",
    });
    expect(avisoDaAutorizacao({ ...LOJA, authorization_expires_at: diasAdiante(1) }, AGORA)?.rotulo).toBe(
      "Autorização vence em 1 dia",
    );
    expect(avisoDaAutorizacao({ ...LOJA, authorization_expires_at: diasAdiante(0) }, AGORA)?.rotulo).toBe(
      "Autorização vence hoje",
    );
  });

  it("vencida: perigo", () => {
    expect(avisoDaAutorizacao({ ...LOJA, authorization_expires_at: horasAtras(2) }, AGORA)).toMatchObject({
      tom: "perigo",
      rotulo: "Autorização vencida",
    });
  });
});

describe("lojaDeTeste", () => {
  it("só a live é real", () => {
    expect(lojaDeTeste({ environment: "live" })).toBe(false);
    expect(lojaDeTeste({ environment: "sandbox" })).toBe(true);
  });
});
