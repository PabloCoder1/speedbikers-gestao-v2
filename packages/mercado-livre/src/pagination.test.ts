import { describe, expect, it, vi } from "vitest";

import { paginateOffset } from "./pagination.js";

interface Item {
  id: number;
}

describe("paginateOffset", () => {
  it("percorre todas as páginas até alcançar paging.total", async () => {
    const todos: Item[] = Array.from({ length: 125 }, (_, index) => ({ id: index + 1 }));

    const fetchPage = vi.fn(({ offset, limit }: { offset: number; limit: number }) =>
      Promise.resolve({
        results: todos.slice(offset, offset + limit),
        paging: { total: todos.length, offset, limit },
      }),
    );

    const paginas: Item[][] = [];
    for await (const pagina of paginateOffset({ fetchPage, limit: 50 })) {
      paginas.push(pagina);
    }

    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(paginas.map((p) => p.length)).toEqual([50, 50, 25]);
    expect(paginas.flat()).toHaveLength(125);
  });

  it("para imediatamente quando a primeira página já vem vazia", async () => {
    const fetchPage = vi.fn(() =>
      Promise.resolve({
        results: [] as Item[],
        paging: { total: 0, offset: 0, limit: 50 },
      }),
    );

    const paginas: Item[][] = [];
    for await (const pagina of paginateOffset({ fetchPage })) {
      paginas.push(pagina);
    }

    expect(paginas).toHaveLength(0);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("usa o limit padrão de 50 quando nenhum é informado", async () => {
    const fetchPage = vi.fn(({ limit }: { offset: number; limit: number }) =>
      Promise.resolve({
        results: [] as Item[],
        paging: { total: 0, offset: 0, limit },
      }),
    );

    for await (const pagina of paginateOffset({ fetchPage })) {
      expect(pagina).toBeUndefined(); // nunca deveria iterar
    }

    expect(fetchPage).toHaveBeenCalledWith({ offset: 0, limit: 50 });
  });

  it("para quando total é alcançado exatamente no fim de uma página cheia", async () => {
    const todos: Item[] = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));

    const fetchPage = vi.fn(({ offset, limit }: { offset: number; limit: number }) =>
      Promise.resolve({
        results: todos.slice(offset, offset + limit),
        paging: { total: todos.length, offset, limit },
      }),
    );

    const paginas: Item[][] = [];
    for await (const pagina of paginateOffset({ fetchPage, limit: 50 })) {
      paginas.push(pagina);
    }

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(paginas.flat()).toHaveLength(100);
  });
});
