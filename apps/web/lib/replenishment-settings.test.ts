import { describe, expect, it } from "vitest";

import { lerRegrasDeReposicao } from "./replenishment-settings";

describe("lerRegrasDeReposicao", () => {
  it("continua pelo último ID quando o servidor corta a página", async () => {
    const regras = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const cursores: (string | null)[] = [];
    const resultado = await lerRegrasDeReposicao((depoisDe, limite) => {
      cursores.push(depoisDe);
      const restantes = regras.filter((r) => depoisDe === null || r.id > depoisDe);

      return Promise.resolve({ data: restantes.slice(0, Math.min(limite, 2)), count: restantes.length, error: null });
    });

    expect(cursores).toEqual([null, "b"]);
    expect(resultado).toEqual({ data: regras, error: null });
  });

  it("descarta o lote anterior se uma página falhar", async () => {
    const error = { message: "falha na leitura" };
    const resultado = await lerRegrasDeReposicao((depoisDe) =>
      Promise.resolve(
        depoisDe === null ? { data: [{ id: "a" }], count: 2, error: null } : { data: null, count: null, error },
      ),
    );

    expect(resultado).toEqual({ data: null, error });
  });
});
