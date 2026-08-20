import { createLogger } from "@sb/observability";
import { describe, expect, it, vi } from "vitest";

import type { ParseDeps } from "./erp-import-parse.js";
import { createErpImportParseHandler } from "./erp-import-parse.js";

const BATCH = "b1000000-0000-4000-8000-00000000000b";

const ENVELOPE = {
  jobType: "erp.import.parse",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
  organizationId: "11111111-0000-4000-8000-000000000001",
  dedupeKey: `erp-parse:${BATCH}`,
  attempt: 1,
  enqueuedAt: "2026-08-20T12:00:00.000Z",
};

const STOCK_SHEET = [
  ["SKU", "Título", "Armazém", "Estante", "Estoque Baixo", "Em Trânsito(Compra)",
   "Em Trânsito(Transferência）", "Ocupado", "Disponível", "Estoque Atual", "Custo Médio", "Subtotal", "Criado"],
  ["PI50.DEFEITO", "Painel", "ESTOQUE LOJA", null, 0, 0, 0, 0, 4, 4, null, null, null],
  ["FA100", "Farol", "ESTOQUE LOJA", null, 0, 0, 0, 2, 8, 10, null, null, null],
];

const LINK_SHEET = [
  ["SKU", "Mapeado SKU do Anúncio", "Variante", "ID do Anúncio", "ID da Variante", "Nome da Loja", "Atualizado"],
  ["PI150", "-", "-", "MLB1722724235", "205704879161", "mercado-ML- Speedbikers (loja 1)", null],
  ["PI150", "-", "-", "MLB1", "MLB1", "shopee-Speedbikers", null],
  [null, "-", "-", "MLB2", "MLB2", "mercado-ML - GMR", null],
];

interface Captured {
  updates: Record<string, unknown>[];
  inserted: Record<string, unknown>[][];
  deletedTables: string[];
}

function fakeDeps(options: {
  sheet?: readonly (readonly unknown[])[];
  kind?: string;
  status?: string;
  batchMissing?: boolean;
  readFails?: boolean;
}): { deps: ParseDeps; captured: Captured; lines: string[] } {
  const captured: Captured = { updates: [], inserted: [], deletedTables: [] };
  const lines: string[] = [];

  const db = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data:
                options.batchMissing === true
                  ? null
                  : {
                      id: BATCH,
                      kind: options.kind ?? "STOCK",
                      storage_path: "org/2026-08/hash.xlsx",
                      status: options.status ?? "UPLOADED",
                      organization_id: ENVELOPE.organizationId,
                    },
              error: null,
            }),
        }),
      }),
      update: (values: Record<string, unknown>) => {
        captured.updates.push(values);

        return { eq: () => Promise.resolve({ error: null }) };
      },
      insert: (rows: Record<string, unknown>[]) => {
        captured.inserted.push(rows);

        return Promise.resolve({ error: null });
      },
      delete: () => {
        captured.deletedTables.push(table);

        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  } as unknown as ParseDeps["db"];

  return {
    captured,
    lines,
    deps: {
      db,
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      reader: {
        read: () =>
          options.readFails === true
            ? Promise.reject(new Error("bucket fora do ar"))
            : Promise.resolve(options.sheet ?? STOCK_SHEET),
      },
    },
  };
}

function ctx(lines: string[], payload: unknown): { logger: ReturnType<typeof createLogger>; payload: unknown } {
  return { logger: createLogger({}, { sink: (line) => lines.push(line) }), payload };
}

describe("parse do arquivo do UpSeller", () => {
  it("mapeia as linhas e marca o lote como PARSED", async () => {
    const { deps, captured, lines } = fakeDeps({});

    const outcome = await createErpImportParseHandler(deps)(ENVELOPE, ctx(lines, { batchId: BATCH }));

    expect(outcome).toEqual({ status: "done", processed: 2 });
    expect(captured.updates.at(-1)).toMatchObject({
      status: "PARSED",
      total_rows: 2,
      ok_rows: 2,
      invalid_rows: 0,
    });
  });

  it("numera as linhas como no arquivo, contando o cabeçalho", async () => {
    // O operador vai comparar com a planilha aberta: a primeira linha de dados
    // é a 2, não a 0.
    const { deps, captured, lines } = fakeDeps({});

    await createErpImportParseHandler(deps)(ENVELOPE, ctx(lines, { batchId: BATCH }));

    expect(captured.inserted[0]?.map((r) => r.row_number)).toEqual([2, 3]);
  });

  it("separa SKIPPED de INVALID na contagem", async () => {
    const { deps, captured, lines } = fakeDeps({ kind: "LINKS", sheet: LINK_SHEET });

    await createErpImportParseHandler(deps)(ENVELOPE, ctx(lines, { batchId: BATCH }));

    expect(captured.updates.at(-1)).toMatchObject({
      total_rows: 3,
      ok_rows: 1,
      skipped_rows: 1,
      invalid_rows: 1,
    });
  });

  it("limpa antes de inserir — reexecução não colide com a chave única", async () => {
    const { deps, captured, lines } = fakeDeps({});

    await createErpImportParseHandler(deps)(ENVELOPE, ctx(lines, { batchId: BATCH }));

    expect(captured.deletedTables).toContain("erp_import_rows");
    expect(captured.deletedTables).toContain("erp_stock_snapshots");
  });

  it("arquivo trocado falha de imediato, sem produzir milhares de linhas inválidas", async () => {
    const { deps, captured, lines } = fakeDeps({ kind: "PRODUCTS", sheet: STOCK_SHEET });

    const outcome = await createErpImportParseHandler(deps)(ENVELOPE, ctx(lines, { batchId: BATCH }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(captured.updates.at(-1)).toMatchObject({ status: "FAILED" });
    expect(captured.inserted).toHaveLength(0);
    expect(lines.join()).toContain("erp_parse_wrong_file");
  });

  it("payload sem batchId é falha DEFINITIVA — repetir não resolve", async () => {
    const { deps, lines } = fakeDeps({});

    const outcome = await createErpImportParseHandler(deps)(ENVELOPE, ctx(lines, { nada: true }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });

  it("lote inexistente é falha definitiva", async () => {
    const { deps, lines } = fakeDeps({ batchMissing: true });

    const outcome = await createErpImportParseHandler(deps)(ENVELOPE, ctx(lines, { batchId: BATCH }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });

  it("lote já APLICADO não é reprocessado", async () => {
    // Reprocessar reescreveria a conferência que sustentou a decisão humana.
    const { deps, captured, lines } = fakeDeps({ status: "APPLIED" });

    const outcome = await createErpImportParseHandler(deps)(ENVELOPE, ctx(lines, { batchId: BATCH }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(captured.inserted).toHaveLength(0);
  });

  it("bucket indisponível é falha TRANSITÓRIA — a fila repete", async () => {
    const { deps, captured, lines } = fakeDeps({ readFails: true });

    const outcome = await createErpImportParseHandler(deps)(ENVELOPE, ctx(lines, { batchId: BATCH }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(captured.updates.at(-1)).toMatchObject({ status: "FAILED" });
  });

  it("não altera catálogo, estoque nem vínculo", async () => {
    // O parse só escreve staging. Alterar domínio aqui pularia a conferência.
    const { deps, captured, lines } = fakeDeps({});
    const spy = vi.spyOn(deps.db, "from");

    await createErpImportParseHandler(deps)(ENVELOPE, ctx(lines, { batchId: BATCH }));

    const tables = spy.mock.calls.map((c) => c[0]);

    expect(tables).not.toContain("skus");
    expect(tables).not.toContain("sku_listing_links");
    expect(tables).not.toContain("inventory_balances");
    expect(captured.inserted.flat().length).toBeGreaterThan(0);
  });
});
