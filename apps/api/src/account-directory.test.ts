import { describe, expect, it } from "vitest";

import type { AccountRef } from "./account-directory.js";
import { createAccountDirectory, loadAccountsFromDb } from "./account-directory.js";

const SELLER_1 = 987654321;
const SELLER_2 = 123456789;

const LOJA_1: AccountRef = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  organization_id: "11111111-0000-4000-8000-000000000001",
  slug: "speedbikers-loja-1",
};

const LOJA_2: AccountRef = {
  id: "aaaaaaaa-0000-4000-8000-000000000002",
  organization_id: "11111111-0000-4000-8000-000000000001",
  slug: "speedbikers-loja-2",
};

function relogio(): { now: () => number; avancar: (ms: number) => void } {
  let instante = 0;

  return {
    now: () => instante,
    avancar: (ms) => {
      instante += ms;
    },
  };
}

/** Carga que devolve as versões na ordem, repetindo a última. */
function cargas(...versoes: Map<number, AccountRef>[]): { load: () => Promise<Map<number, AccountRef>>; chamadas: () => number } {
  let chamadas = 0;

  return {
    load: () => {
      const versao = versoes[Math.min(chamadas, versoes.length - 1)] ?? new Map<number, AccountRef>();
      chamadas += 1;

      return Promise.resolve(versao);
    },
    chamadas: () => chamadas,
  };
}

describe("createAccountDirectory (D-346)", () => {
  it("cem consultas simultâneas com o diretório vazio fazem UMA carga — a rajada não vira cem consultas", async () => {
    let chamadas = 0;
    let liberar: (contas: Map<number, AccountRef>) => void = () => undefined;
    const pendente = new Promise<Map<number, AccountRef>>((resolve) => {
      liberar = resolve;
    });
    const diretorio = createAccountDirectory({
      load: () => {
        chamadas += 1;

        return pendente;
      },
    });

    const consultas = Array.from({ length: 100 }, () => diretorio.resolve(SELLER_1));
    liberar(new Map([[SELLER_1, LOJA_1]]));
    const resultados = await Promise.all(consultas);

    expect(chamadas).toBe(1);
    expect(resultados.every((conta) => conta === LOJA_1)).toBe(true);
  });

  it("dentro do prazo, nenhuma consulta nova vai ao banco", async () => {
    const { now, avancar } = relogio();
    const carga = cargas(new Map([[SELLER_1, LOJA_1]]));
    const diretorio = createAccountDirectory({ load: carga.load, now, ttlMs: 300_000 });

    await diretorio.resolve(SELLER_1);
    avancar(299_000);
    await diretorio.resolve(SELLER_1);

    expect(carga.chamadas()).toBe(1);
  });

  it("vencido o prazo, a próxima consulta recarrega", async () => {
    const { now, avancar } = relogio();
    const carga = cargas(new Map([[SELLER_1, LOJA_1]]));
    const diretorio = createAccountDirectory({ load: carga.load, now, ttlMs: 300_000 });

    await diretorio.resolve(SELLER_1);
    avancar(300_000);
    await diretorio.resolve(SELLER_1);

    expect(carga.chamadas()).toBe(2);
  });

  it("seller desconhecido logo depois da carga não recarrega: enxurrada de estranho não vira enxurrada de consulta", async () => {
    const { now, avancar } = relogio();
    const carga = cargas(new Map([[SELLER_1, LOJA_1]]));
    const diretorio = createAccountDirectory({ load: carga.load, now, unknownSellerReloadMinMs: 30_000 });

    await diretorio.resolve(SELLER_1);
    avancar(10_000);

    for (let i = 0; i < 20; i += 1) {
      await expect(diretorio.resolve(SELLER_2)).resolves.toBeNull();
    }

    expect(carga.chamadas()).toBe(1);
  });

  it("conta recém-conectada aparece na recarga por desconhecido, sem esperar o prazo", async () => {
    const { now, avancar } = relogio();
    const carga = cargas(
      new Map([[SELLER_1, LOJA_1]]),
      new Map([
        [SELLER_1, LOJA_1],
        [SELLER_2, LOJA_2],
      ]),
    );
    const diretorio = createAccountDirectory({ load: carga.load, now, ttlMs: 300_000, unknownSellerReloadMinMs: 30_000 });

    await diretorio.resolve(SELLER_1);
    avancar(31_000);

    await expect(diretorio.resolve(SELLER_2)).resolves.toBe(LOJA_2);
    expect(carga.chamadas()).toBe(2);
  });

  it("falha na primeira carga, sem nada em memória, rejeita", async () => {
    const diretorio = createAccountDirectory({ load: () => Promise.reject(new Error("banco fora do ar")) });

    await expect(diretorio.resolve(SELLER_1)).rejects.toThrow("banco fora do ar");
  });

  it("falha na recarga com contas em memória serve as antigas e só tenta de novo depois do intervalo", async () => {
    const { now, avancar } = relogio();
    let chamadas = 0;
    const diretorio = createAccountDirectory({
      load: () => {
        chamadas += 1;

        return chamadas === 1 ? Promise.resolve(new Map([[SELLER_1, LOJA_1]])) : Promise.reject(new Error("banco fora do ar"));
      },
      now,
      ttlMs: 300_000,
      unknownSellerReloadMinMs: 30_000,
    });

    await diretorio.resolve(SELLER_1);
    avancar(300_000);
    await expect(diretorio.resolve(SELLER_1)).resolves.toBe(LOJA_1);
    expect(chamadas).toBe(2);

    avancar(10_000);
    await diretorio.resolve(SELLER_1);
    expect(chamadas).toBe(2);

    avancar(21_000);
    await diretorio.resolve(SELLER_1);
    expect(chamadas).toBe(3);
  });
});

describe("loadAccountsFromDb (D-346)", () => {
  function dbCom(
    linhas: { id: string; organization_id: string; slug: string; seller_id: number | null }[] | null,
    erro: { message: string } | null = null,
  ): Parameters<typeof loadAccountsFromDb>[0] {
    return {
      from: () => ({ select: () => Promise.resolve({ data: linhas, error: erro }) }),
    } as unknown as Parameters<typeof loadAccountsFromDb>[0];
  }

  it("mapeia por seller_id e ignora conta sem OAuth concluído", async () => {
    const contas = await loadAccountsFromDb(
      dbCom([
        { ...LOJA_1, seller_id: SELLER_1 },
        { ...LOJA_2, seller_id: null },
      ]),
    );

    expect([...contas.entries()]).toEqual([[SELLER_1, LOJA_1]]);
  });

  it("seller repetido fica fora do mapa — a consulta antiga com maybeSingle respondia 'conta desconhecida'", async () => {
    const contas = await loadAccountsFromDb(
      dbCom([
        { ...LOJA_1, seller_id: SELLER_1 },
        { ...LOJA_2, seller_id: SELLER_1 },
        { ...LOJA_2, seller_id: SELLER_2 },
      ]),
    );

    expect(contas.has(SELLER_1)).toBe(false);
    expect(contas.get(SELLER_2)).toEqual(LOJA_2);
  });

  it("erro do banco rejeita com o motivo", async () => {
    await expect(loadAccountsFromDb(dbCom(null, { message: "timeout" }))).rejects.toThrow("falha ao carregar ml_accounts: timeout");
  });
});
