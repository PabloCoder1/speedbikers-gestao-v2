import { describe, expect, it } from "vitest";

import { MAX_PAGINAS_SEM_TETO, PAGINA_DO_POSTGREST, lerPaginasDaRpc } from "./rpc-pages";

/** Um "servidor" com `total` linhas que, como o PostgREST, nunca devolve mais que `maxRows`. */
function servidor(total: number, maxRows = PAGINA_DO_POSTGREST, comContagem = false) {
  const chamadas: { offset: number; limite: number }[] = [];
  const lerPagina = (offset: number, limite: number) => {
    chamadas.push({ offset, limite });
    const fim = Math.min(total, offset + Math.min(limite, maxRows));
    const data = Array.from({ length: Math.max(0, fim - offset) }, (_, i) => offset + i);

    return Promise.resolve({ data, error: null, count: comContagem && offset === 0 ? total : null });
  };

  return { lerPagina, chamadas };
}

describe("lerPaginasDaRpc", () => {
  it("termina na primeira página quando o total exato coincide com a resposta", async () => {
    const { lerPagina, chamadas } = servidor(30, PAGINA_DO_POSTGREST, true);
    const { linhas } = await lerPaginasDaRpc(lerPagina, 5_000);

    expect(linhas).toHaveLength(30);
    expect(chamadas).toEqual([{ offset: 0, limite: 1_000 }]);
  });

  it("continua paginando se o total exato supera a primeira página limitada pelo servidor", async () => {
    const { lerPagina, chamadas } = servidor(750, 300, true);
    const { linhas } = await lerPaginasDaRpc(lerPagina, 5_000);

    expect(linhas).toEqual(Array.from({ length: 750 }, (_, i) => i));
    expect(chamadas.map(({ offset }) => offset)).toEqual([0, 300, 600, 750]);
  });

  it("lê o recorte inteiro acima do max_rows — o CSV de 4,5 mil anúncios não sai com mil", async () => {
    const { lerPagina } = servidor(4_500);

    const { linhas, error } = await lerPaginasDaRpc(lerPagina, 5_000);

    expect(error).toBeNull();
    expect(linhas).toHaveLength(4_500);
    expect(new Set(linhas).size).toBe(4_500);
  });

  it("para no teto, para a rota poder dizer no nome do arquivo que cortou", async () => {
    const { lerPagina, chamadas } = servidor(12_000);

    const { linhas } = await lerPaginasDaRpc(lerPagina, 5_000);

    expect(linhas).toHaveLength(5_000);
    expect(chamadas.at(-1)).toEqual({ offset: 4_000, limite: 1_000 });
  });

  it("servidor com teto menor que o pedido: avança pelo que chegou e não pula linha", async () => {
    const { lerPagina } = servidor(2_300, 500);

    const { linhas } = await lerPaginasDaRpc(lerPagina, 5_000);

    expect(linhas).toEqual(Array.from({ length: 2_300 }, (_, i) => i));
  });

  it("erro em qualquer página preserva o código e descarta a leitura incompleta", async () => {
    let n = 0;
    const lerPagina = () => {
      n += 1;
      return Promise.resolve(
        n === 2 ? { data: null, error: { message: "boom", code: "PGRST202" } } : { data: Array(1_000).fill(0) as number[], error: null },
      );
    };

    await expect(lerPaginasDaRpc(lerPagina, 5_000)).resolves.toEqual({ linhas: [], error: { message: "boom", code: "PGRST202" } });
  });

  it("aceita teto Number.POSITIVE_INFINITY (contrato do Dashboard do SKU) com guarda contra laço infinito", async () => {
    const { lerPagina, chamadas } = servidor(1_250, PAGINA_DO_POSTGREST, true);
    const { linhas, error } = await lerPaginasDaRpc(lerPagina, Number.POSITIVE_INFINITY);

    expect(error).toBeNull();
    expect(linhas).toHaveLength(1_250);
    expect(chamadas).toEqual([
      { offset: 0, limite: PAGINA_DO_POSTGREST },
      { offset: 1_000, limite: PAGINA_DO_POSTGREST },
      { offset: 1_250, limite: PAGINA_DO_POSTGREST },
    ]);

    let paginas = 0;
    const infinito = () => {
      paginas += 1;
      return Promise.resolve({ data: [paginas], error: null });
    };
    const travado = await lerPaginasDaRpc(infinito, Number.POSITIVE_INFINITY);

    expect(travado.error).toBeNull();
    expect(paginas).toBe(MAX_PAGINAS_SEM_TETO);
    expect(travado.linhas).toHaveLength(MAX_PAGINAS_SEM_TETO);
  });

  it("rejeita NaN, -Infinity e teto <= 0, e trunca teto fracionário respeitando o limite", async () => {
    const chamadas: { offset: number; limite: number }[] = [];
    const lerPagina = (offset: number, limite: number) => {
      chamadas.push({ offset, limite });
      return Promise.resolve({ data: [1, 2, 3, 4, 5], error: null });
    };

    expect(await lerPaginasDaRpc(lerPagina, Number.NaN)).toEqual({ linhas: [], error: null });
    expect(await lerPaginasDaRpc(lerPagina, Number.NEGATIVE_INFINITY)).toEqual({ linhas: [], error: null });
    expect(await lerPaginasDaRpc(lerPagina, 0)).toEqual({ linhas: [], error: null });
    expect(await lerPaginasDaRpc(lerPagina, -10)).toEqual({ linhas: [], error: null });
    expect(chamadas).toEqual([]);

    const parcial = await lerPaginasDaRpc(lerPagina, 2.9);

    expect(chamadas).toEqual([{ offset: 0, limite: 2 }]);
    expect(parcial).toEqual({ linhas: [1, 2], error: null });
  });
});
