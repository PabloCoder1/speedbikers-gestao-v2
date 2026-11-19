import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import { bancoFalso, temFiltro, type ConsultaFalsa, type Resposta } from "./banco-falso.test.js";
import {
  comandoDeItemSchema,
  editDocumentItem,
  valorTotalDoItem,
  type DocumentItemsDeps,
} from "./document-items.js";

const CALLER = { userId: "user-1", organizationId: "org-1", role: "ADMIN" as const };
const DOC = "9c8b7a6d-5e4f-4a3b-9c1d-0e9f8a7b6c5d";

function cenario(
  options: { status?: string; itens?: number; vinculados?: number; unitValue?: number | null; itemExiste?: boolean } = {},
): { deps: DocumentItemsDeps; consultas: ConsultaFalsa[] } {
  const responder = (consulta: ConsultaFalsa): Resposta => {
    if (consulta.tabela === "documents" && consulta.operacao === "select") {
      return { data: { id: DOC, status: options.status ?? "PARSED" } };
    }

    if (consulta.tabela === "document_items" && consulta.operacao === "select" && consulta.single) {
      return {
        data:
          options.itemExiste === false
            ? null
            : { id: 7, quantity: 12, unit_value: "unitValue" in options ? options.unitValue : 10.5 },
      };
    }

    if (consulta.tabela === "document_items" && consulta.operacao === "select") {
      const vinculados = consulta.filtros.some(([op]) => op === "not.is");

      return { count: vinculados ? (options.vinculados ?? 2) : (options.itens ?? 3) };
    }

    return {};
  };
  const { db, consultas } = bancoFalso(responder);

  return {
    consultas,
    deps: { db: db as DocumentItemsDeps["db"], logger: createLogger({}, { sink: () => undefined }) },
  };
}

describe("comandoDeItemSchema", () => {
  it("aceita quantidade positiva com até três casas e o remover", () => {
    expect(comandoDeItemSchema.safeParse({ acao: "quantidade", quantidade: 10 }).success).toBe(true);
    expect(comandoDeItemSchema.safeParse({ acao: "quantidade", quantidade: 1.25 }).success).toBe(true);
    expect(comandoDeItemSchema.safeParse({ acao: "quantidade", quantidade: 1.2345 }).success).toBe(false);
    expect(comandoDeItemSchema.safeParse({ acao: "quantidade", quantidade: 0 }).success).toBe(false);
    expect(comandoDeItemSchema.safeParse({ acao: "remover" }).success).toBe(true);
    expect(comandoDeItemSchema.safeParse({ acao: "apagar-tudo" }).success).toBe(false);
  });
});

describe("valorTotalDoItem", () => {
  it("acompanha a quantidade e continua sem valor quando o documento não tem preço", () => {
    expect(valorTotalDoItem(10.5, 10)).toBe(105);
    expect(valorTotalDoItem(null, 10)).toBeNull();
  });
});

describe("editDocumentItem", () => {
  it("muda a quantidade e o valor total do item, e reconta o documento só em conferência", async () => {
    const ctx = cenario();

    const outcome = await editDocumentItem(ctx.deps, CALLER, DOC, 7, { acao: "quantidade", quantidade: 10 });

    expect(outcome).toEqual({ status: "updated", totalItems: 3, resolvedItems: 2 });

    const item = ctx.consultas.find((c) => c.tabela === "document_items" && c.operacao === "update");

    expect(item?.valores).toEqual({ quantity: 10, total_value: 105 });
    expect(item !== undefined && temFiltro(item, "document_id", DOC)).toBe(true);

    const documento = ctx.consultas.find((c) => c.tabela === "documents" && c.operacao === "update");

    expect(documento?.valores).toEqual({ total_items: 3, resolved_items: 2 });
    expect(documento !== undefined && temFiltro(documento, "status", "PARSED")).toBe(true);
  });

  it("procura o documento na organização de quem chama", async () => {
    const ctx = cenario();

    await editDocumentItem(ctx.deps, CALLER, DOC, 7, { acao: "remover" });

    const leitura = ctx.consultas[0];

    expect(leitura !== undefined && temFiltro(leitura, "organization_id", "org-1")).toBe(true);
  });

  it("remove o item quando sobra outro", async () => {
    const ctx = cenario({ itens: 3 });

    const outcome = await editDocumentItem(ctx.deps, CALLER, DOC, 7, { acao: "remover" });

    expect(outcome.status).toBe("updated");
    expect(ctx.consultas.some((c) => c.tabela === "document_items" && c.operacao === "delete")).toBe(true);
  });

  it("não remove o último item do documento", async () => {
    const ctx = cenario({ itens: 1 });

    const outcome = await editDocumentItem(ctx.deps, CALLER, DOC, 7, { acao: "remover" });

    expect(outcome.status).toBe("rejected");
    expect(ctx.consultas.some((c) => c.operacao === "delete")).toBe(false);
  });

  it("documento fora da conferência não aceita alteração", async () => {
    const ctx = cenario({ status: "APPLIED" });

    const outcome = await editDocumentItem(ctx.deps, CALLER, DOC, 7, { acao: "quantidade", quantidade: 1 });

    expect(outcome.status).toBe("rejected");
    expect(ctx.consultas.some((c) => c.operacao === "update" || c.operacao === "delete")).toBe(false);
  });

  it("item de outro documento é não encontrado", async () => {
    const ctx = cenario({ itemExiste: false });

    expect((await editDocumentItem(ctx.deps, CALLER, DOC, 99, { acao: "remover" })).status).toBe("not_found");
  });
});
