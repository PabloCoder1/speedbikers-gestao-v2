import { describe, expect, it } from "vitest";

import {
  RELIST_REOPENABLE_STATES,
  RELIST_STATES,
  RELIST_TERMINAL_STATES,
  canTransitionRelist,
  relistStateRequiresHuman,
} from "./relist.js";

describe("máquina de estados do relist (D-159)", () => {
  it("o caminho feliz inteiro é transitável, na ordem", () => {
    const happy = ["REQUESTED", "CLOSING", "CLOSED", "RELISTING", "RELISTED", "REMAPPED"] as const;

    for (let i = 0; i < happy.length - 1; i += 1) {
      expect(canTransitionRelist(happy[i]!, happy[i + 1]!)).toBe(true);
    }
  });

  it("NUNCA se emite o POST sem o pai confirmado fechado — RELISTING só nasce de CLOSED ou de retry humano", () => {
    for (const from of RELIST_STATES) {
      if (canTransitionRelist(from, "RELISTING")) {
        expect(["CLOSED", "RELIST_FAILED"]).toContain(from);
      }
    }
  });

  it("pular etapas é proibido: REQUESTED não vai direto a CLOSED nem a RELISTED", () => {
    expect(canTransitionRelist("REQUESTED", "CLOSED")).toBe(false);
    expect(canTransitionRelist("REQUESTED", "RELISTED")).toBe(false);
    expect(canTransitionRelist("CLOSING", "RELISTING")).toBe(false);
  });

  it("terminal não tem saída; não-terminal tem pelo menos uma", () => {
    for (const state of RELIST_STATES) {
      const outgoing = RELIST_STATES.filter((to) => canTransitionRelist(state, to));

      if (RELIST_TERMINAL_STATES.includes(state)) {
        expect(outgoing).toHaveLength(0);
      } else {
        expect(outgoing.length).toBeGreaterThan(0);
      }
    }
  });

  it("reabrível é subconjunto de terminal — só se reabre o que ACABOU sem estrago remoto", () => {
    for (const state of RELIST_REOPENABLE_STATES) {
      expect(RELIST_TERMINAL_STATES).toContain(state);
    }

    // REMAPPED é terminal mas NÃO reabrível: "uma republicação por pai" é
    // regra do próprio Mercado Livre (tag relist, secao 2.16).
    expect(RELIST_REOPENABLE_STATES).not.toContain("REMAPPED");
  });

  it("RELIST_FAILED exige gente: não é terminal, não é reabrível, e o único caminho é o retry", () => {
    expect(relistStateRequiresHuman("RELIST_FAILED")).toBe(true);
    expect(RELIST_TERMINAL_STATES).not.toContain("RELIST_FAILED");
    expect(RELIST_REOPENABLE_STATES).not.toContain("RELIST_FAILED");

    const outgoing = RELIST_STATES.filter((to) => canTransitionRelist("RELIST_FAILED", to));
    expect(outgoing).toEqual(["RELISTING"]);
  });

  it("nenhum outro estado exige gente — o sinal é específico, não genérico", () => {
    for (const state of RELIST_STATES) {
      if (state !== "RELIST_FAILED") {
        expect(relistStateRequiresHuman(state)).toBe(false);
      }
    }
  });
});
