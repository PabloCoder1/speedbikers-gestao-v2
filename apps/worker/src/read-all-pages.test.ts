import { describe, expect, it } from "vitest";

import { POSTGREST_MAX_ROWS, readAllPages } from "./read-all-pages.js";

/**
 * Fonte que se comporta como o PostgREST real: honra `range`, mas NUNCA
 * devolve mais que `max_rows` linhas — e não avisa quando corta (D-131).
 */
function fonte(total: number, maxRows = POSTGREST_MAX_ROWS) {
  const chamadas: [number, number][] = [];
  const linhas = Array.from({ length: total }, (_, i) => ({ id: i }));

  return {
    chamadas,
    ler: (from: number, to: number) => {
      chamadas.push([from, to]);

      const fim = Math.min(to + 1, from + maxRows);

      return Promise.resolve({ data: linhas.slice(from, fim), error: null });
    },
  };
}

describe("readAllPages", () => {
  it("traz o conjunto inteiro quando ele passa do teto de uma resposta", async () => {
    const f = fonte(2524);

    const linhas = await readAllPages(f.ler);

    // O número real de `inventory_balances` em produção quando o defeito foi
    // achado. Sem paginação viriam 1.000, e o handler trataria as outras
    // 1.524 como saldo zero.
    expect(linhas).toHaveLength(2524);
    expect(linhas[2523]).toEqual({ id: 2523 });
    expect(f.chamadas).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("faz uma requisição a mais quando o total é múltiplo exato da página", async () => {
    const f = fonte(2000);

    const linhas = await readAllPages(f.ler);

    // A última página volta CHEIA, então não dá para saber que acabou sem
    // perguntar de novo. Uma requisição extra é o preço de não parar cedo.
    expect(linhas).toHaveLength(2000);
    expect(f.chamadas).toHaveLength(3);
  });

  it("conjunto que cabe numa página faz uma requisição só", async () => {
    const f = fonte(7);

    expect(await readAllPages(f.ler)).toHaveLength(7);
    expect(f.chamadas).toEqual([[0, 999]]);
  });

  it("conjunto vazio não entra em laço", async () => {
    const f = fonte(0);

    expect(await readAllPages(f.ler)).toEqual([]);
    expect(f.chamadas).toHaveLength(1);
  });

  it("pageSize acima do teto do servidor é rebaixado — pedir 5.000 pararia no primeiro lote", async () => {
    // Se o helper aceitasse pageSize 5.000, ele pediria range(0, 4999), o
    // servidor devolveria 1.000, e `lote.length < pageSize` daria "acabou"
    // com 1.000 de 2.524. O rebaixamento é o que impede esse falso fim.
    const f = fonte(2524);

    const linhas = await readAllPages(f.ler, { pageSize: 5000 });

    expect(linhas).toHaveLength(2524);
  });

  it("erro em qualquer página propaga, com o label do chamador", async () => {
    let chamada = 0;

    const ler = (from: number, to: number) => {
      chamada += 1;

      if (chamada === 2) {
        return Promise.resolve({ data: null, error: { message: "boom" } });
      }

      return Promise.resolve({ data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: i })), error: null });
    };

    await expect(readAllPages(ler, { label: "falha ao ler tabela_x" })).rejects.toThrow(
      "falha ao ler tabela_x: boom",
    );
  });

  it("pageSize inválido é recusado na entrada, não vira laço infinito", async () => {
    const f = fonte(10);

    await expect(readAllPages(f.ler, { pageSize: 0 })).rejects.toThrow("pageSize");
  });
});
