import { describe, expect, it } from "vitest";

/**
 * Dublê mínimo do cliente do Supabase para os testes de D-766.
 *
 * Cada `from(tabela)` abre uma consulta que guarda a operação (select, update,
 * delete, upsert), os valores e os filtros encadeados; a resposta vem de
 * `responder`, que olha a consulta inteira. Tudo que foi pedido fica em
 * `consultas`, para o teste conferir o que foi escrito.
 */

export interface ConsultaFalsa {
  tabela: string;
  operacao: "select" | "update" | "delete" | "upsert";
  valores: unknown;
  opcoes: unknown;
  filtros: [string, string, unknown][];
  single: boolean;
}

export interface Resposta {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
}

export function bancoFalso(responder: (consulta: ConsultaFalsa) => Resposta): {
  db: unknown;
  consultas: ConsultaFalsa[];
} {
  const consultas: ConsultaFalsa[] = [];

  const db = {
    from(tabela: string) {
      const consulta: ConsultaFalsa = {
        tabela,
        operacao: "select",
        valores: null,
        opcoes: null,
        filtros: [],
        single: false,
      };
      consultas.push(consulta);

      const responder_ = (): Promise<Resposta> => {
        const resposta = responder(consulta);

        return Promise.resolve({ data: null, error: null, count: null, ...resposta });
      };

      const construtor: Record<string, unknown> = {
        select(_colunas: string, opcoes?: unknown) {
          if (consulta.operacao === "select") consulta.opcoes = opcoes ?? null;

          return construtor;
        },
        update(valores: unknown) {
          consulta.operacao = "update";
          consulta.valores = valores;

          return construtor;
        },
        delete() {
          consulta.operacao = "delete";

          return construtor;
        },
        upsert(valores: unknown, opcoes?: unknown) {
          consulta.operacao = "upsert";
          consulta.valores = valores;
          consulta.opcoes = opcoes ?? null;

          return construtor;
        },
        eq(coluna: string, valor: unknown) {
          consulta.filtros.push(["eq", coluna, valor]);

          return construtor;
        },
        in(coluna: string, valor: unknown) {
          consulta.filtros.push(["in", coluna, valor]);

          return construtor;
        },
        not(coluna: string, operador: string, valor: unknown) {
          consulta.filtros.push([`not.${operador}`, coluna, valor]);

          return construtor;
        },
        maybeSingle() {
          consulta.single = true;

          return responder_();
        },
        then(resolve: (valor: Resposta) => unknown, reject?: (erro: unknown) => unknown) {
          return responder_().then(resolve, reject);
        },
      };

      return construtor;
    },
  };

  return { db, consultas };
}

export function temFiltro(consulta: ConsultaFalsa, coluna: string, valor?: unknown): boolean {
  return consulta.filtros.some(([, c, v]) => c === coluna && (valor === undefined || v === valor));
}

// Vitest roda todo `*.test.ts`; este arquivo é o dublê, e prova o próprio contrato.

describe("bancoFalso", () => {
  it("guarda a consulta e devolve a resposta escolhida", async () => {
    const { db, consultas } = bancoFalso(() => ({ data: [1] }));
    const resposta = await (db as { from: (t: string) => { select: (c: string) => Promise<{ data: unknown }> } })
      .from("skus")
      .select("id");

    expect(resposta.data).toEqual([1]);
    expect(consultas[0]?.tabela).toBe("skus");
  });
});
