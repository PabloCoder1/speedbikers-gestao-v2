import { describe, expect, it } from "vitest";

import { formatAge } from "./relative-time";

const agora = new Date("2026-09-08T12:00:00.000Z");
const atras = (ms: number) => new Date(agora.getTime() - ms).toISOString();

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

describe("idade de um registro", () => {
  it("abaixo de um minuto não vira 'há 0 min'", () => {
    expect(formatAge(atras(30_000), agora)).toBe("agora há pouco");
  });

  it("minutos e horas", () => {
    expect(formatAge(atras(12 * MINUTO), agora)).toBe("há 12 min");
    expect(formatAge(atras(3 * HORA), agora)).toBe("há 3 h");
  });

  /** "há 1 dias" é o defeito de flexão que oito telas já pagaram (D-131). */
  it("um dia tem forma própria", () => {
    expect(formatAge(atras(DIA), agora)).toBe("há 1 dia");
    expect(formatAge(atras(2 * DIA), agora)).toBe("há 2 dias");
  });

  it("as fronteiras caem para a unidade maior", () => {
    expect(formatAge(atras(MINUTO), agora)).toBe("há 1 min");
    expect(formatAge(atras(HORA), agora)).toBe("há 1 h");
  });
});

describe("os três casos que devolvem null, para a tela mostrar a data absoluta", () => {
  it("velho demais para a janela", () => {
    expect(formatAge(atras(8 * DIA), agora)).toBeNull();
    // Sete dias ainda entram; o oitavo não.
    expect(formatAge(atras(7 * DIA - 1), agora)).toBe("há 6 dias");
  });

  /**
   * Relógio do servidor adiantado em relação ao banco é comum. "há -3 min"
   * seria pior do que a data.
   */
  it("futuro não vira contagem negativa", () => {
    expect(formatAge(new Date(agora.getTime() + 5 * MINUTO).toISOString(), agora)).toBeNull();
  });

  it("ilegível ou ausente", () => {
    expect(formatAge(null, agora)).toBeNull();
    expect(formatAge("não é data", agora)).toBeNull();
  });
});
