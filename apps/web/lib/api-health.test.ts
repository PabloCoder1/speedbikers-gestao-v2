import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchApiHealth } from "./api-health";

/**
 * A leitura do `/health` da api (D-231) e o cronômetro que ela ganhou em
 * D-309.
 *
 * O que estes casos guardam é a regra que separa este número de "42 ms"
 * inventado do frame: **sem resposta não há tempo de resposta**. Um número
 * impresso quando a ida falhou seria pior que nenhum — a tela existe
 * justamente para mostrar quando algo não responde.
 */

const original = globalThis.fetch;
const base = process.env.NEXT_PUBLIC_API_URL;

afterEach(() => {
  globalThis.fetch = original;

  if (base === undefined) {
    delete process.env.NEXT_PUBLIC_API_URL;
  } else {
    process.env.NEXT_PUBLIC_API_URL = base;
  }
});

function comApi(corpo: unknown, ok = true): void {
  process.env.NEXT_PUBLIC_API_URL = "https://api.exemplo.test";
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(corpo) } as Response));
}

describe("fetchApiHealth", () => {
  it("devolve commit, início e o tempo DESTA ida", async () => {
    comApi({ status: "ok", commit: "abc1234", startedAt: "2026-09-11T08:12:00.000Z" });

    const saude = await fetchApiHealth();

    expect(saude?.commit).toBe("abc1234");
    expect(saude?.startedAt).toBe("2026-09-11T08:12:00.000Z");
    expect(typeof saude?.latencyMs).toBe("number");
    // Monotônico: nunca negativo, por mais rápida que a ida seja.
    expect(saude?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("resposta sem commit não vira commit inventado", async () => {
    comApi({ status: "ok" });

    const saude = await fetchApiHealth();

    expect(saude?.commit).toBeNull();
    expect(saude?.startedAt).toBeNull();
  });

  /*
    AS TRÊS FORMAS DE NÃO TER RESPOSTA, e todas dão no mesmo lugar: `null`
    inteiro, sem tempo. O chamador traduz isso em "sem resposta" com o motivo
    — nunca em "ok".
  */
  it("HTTP de erro é sem resposta, e sem resposta não tem tempo", async () => {
    comApi({ commit: "naoDeveriaAparecer" }, false);

    expect(await fetchApiHealth()).toBeNull();
  });

  it("falha de rede é sem resposta", async () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.exemplo.test";
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("sem rede")));

    expect(await fetchApiHealth()).toBeNull();
  });

  it("sem endereço configurado, a tela não inventa ida nenhuma", async () => {
    delete process.env.NEXT_PUBLIC_API_URL;
    globalThis.fetch = vi.fn(() => {
      throw new Error("não deveria ter sido chamado");
    });

    expect(await fetchApiHealth()).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
