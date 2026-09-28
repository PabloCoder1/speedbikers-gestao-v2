import { describe, expect, it } from "vitest";

import { PAGINA_DO_POSTGREST, lerPaginasDaRpc } from "./rpc-pages";

/** Um "servidor" com `total` linhas que, como o PostgREST, nunca devolve mais que `maxRows`. */
function servidor(total: number, maxRows = PAGINA_DO_POSTGREST) {
  const chamadas: { offset: number; limite: number }[] = [];
  const lerPagina = (offset: number, limite: number) => {
    chamadas.push({ offset, limite });
    const fim = Math.min(total, offset + Math.min(limite, maxRows));
    const data = Array.from({ length: Math.max(0, fim - offset) }, (_, i) => offset + i);

    return Promise.resolve({ data, error: null });
  };

  return { lerPagina, chamadas };
}

describe("lerPaginasDaRpc", () => {
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

  it("erro em qualquer página devolve o erro, nunca um arquivo pela metade", async () => {
    let n = 0;
    const lerPagina = () => {
      n += 1;
      return Promise.resolve(
        n === 2 ? { data: null, error: { message: "boom" } } : { data: Array(1_000).fill(0) as number[], error: null },
      );
    };

    await expect(lerPaginasDaRpc(lerPagina, 5_000)).resolves.toEqual({ linhas: [], error: { message: "boom" } });
  });
});
