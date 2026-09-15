import { describe, expect, it } from "vitest";

import { tempoRelativo } from "./tempo-relativo";

const AGORA = new Date("2026-09-15T12:00:00Z");

function antes(segundos: number): string {
  return new Date(AGORA.getTime() - segundos * 1000).toISOString();
}

describe("tempoRelativo", () => {
  it("nunca entrou não vira data inventada", () => {
    expect(tempoRelativo(null, AGORA)).toBeNull();
    expect(tempoRelativo("não é data", AGORA)).toBeNull();
  });

  it("menos de um minuto é 'agora há pouco'", () => {
    expect(tempoRelativo(antes(20), AGORA)).toBe("agora há pouco");
  });

  it("minutos, horas, dias, meses e anos, em português", () => {
    expect(tempoRelativo(antes(5 * 60), AGORA)).toBe("há 5 minutos");
    expect(tempoRelativo(antes(3 * 3600), AGORA)).toBe("há 3 horas");
    expect(tempoRelativo(antes(86400), AGORA)).toBe("ontem");
    expect(tempoRelativo(antes(4 * 86400), AGORA)).toBe("há 4 dias");
    expect(tempoRelativo(antes(62 * 86400), AGORA)).toBe("há 2 meses");
    expect(tempoRelativo(antes(800 * 86400), AGORA)).toBe("há 2 anos");
  });
});
