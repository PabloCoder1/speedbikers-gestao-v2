import { createLogger } from "@sb/observability";
import { describe, expect, it, vi } from "vitest";

import type { ParseDeps } from "./erp-import-parse.js";
import { createErpImportParseHandler } from "./erp-import-parse.js";

const BATCH = "b1000000-0000-4000-8000-00000000000b";
const BATCH_VERSION = "2026-08-20T11:59:00.000Z";

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
  publishAttempts: number;
}

function fakeDeps(options: {
  sheet?: readonly (readonly unknown[])[];
  kind?: string;
  status?: string;
  parsedAt?: string;
  batchStateAfterRead?: { status: string; updatedAt: string };
  batchMissing?: boolean;
  readFails?: boolean;
  stageFailsOffset?: number;
  updateError?: (values: Record<string, unknown>) => { message: string } | null;
}): { deps: ParseDeps; captured: Captured; lines: string[] } {
  const captured: Captured = { updates: [], inserted: [], publishAttempts: 0 };
  const lines: string[] = [];
  const staged = new Map<number, Record<string, unknown>[]>();
  let batch = {
    id: BATCH,
    kind: options.kind ?? "STOCK",
    storage_path: "org/2026-08/hash.xlsx",
    status: options.status ?? "UPLOADED",
    parsed_at: options.parsedAt ?? null,
    updated_at: BATCH_VERSION,
    organization_id: ENVELOPE.organizationId,
  };

  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: options.batchMissing === true ? null : batch,
              error: null,
            }),
        }),
      }),
      update: (values: Record<string, unknown>) => {
        const filters = new Map<string, unknown>();
        function execute() {
          const current = (values.status === "PARSING" ? options.batchStateAfterRead : undefined) ??
            { status: batch.status, updatedAt: batch.updated_at };
          const matches =
            (!filters.has("status") || filters.get("status") === current.status) &&
            (!filters.has("updated_at") || filters.get("updated_at") === current.updatedAt);
          const error = options.updateError?.(values) ?? null;
          if (!matches || error !== null) return Promise.resolve({ data: null, error });

          captured.updates.push(values);
          staged.clear();
          batch = {
            ...batch,
            ...values,
            updated_at: new Date(Date.parse(BATCH_VERSION) + captured.updates.length).toISOString(),
          };
          return Promise.resolve({ data: { id: BATCH, updated_at: batch.updated_at }, error: null });
        }
        const update = {
          eq: (column: string, value: unknown) => {
            filters.set(column, value);
            return update;
          },
          select: () => ({ maybeSingle: execute }),
          then: (resolve: (result: Awaited<ReturnType<typeof execute>>) => void) => execute().then(resolve),
        };
        return update;
      },
    }),
    rpc: (name: "stage_erp_parse_chunk" | "publish_erp_parse", args: {
      p_parse_version: string;
      p_offset?: number;
      p_rows?: Record<string, unknown>[];
      p_expected_rows?: number;
      p_parsed_at?: string;
    }) => {
      const current = batch.status === "PARSING" && batch.updated_at === args.p_parse_version;
      if (name === "stage_erp_parse_chunk") {
        if (!current) return Promise.resolve({ data: false, error: null });
        if (args.p_offset === undefined || args.p_rows === undefined) throw new Error("bloco sem posição ou linhas");
        if (options.stageFailsOffset === args.p_offset) {
          return Promise.resolve({ data: null, error: { message: "bloco indisponível" } });
        }
        staged.set(args.p_offset, args.p_rows);
        captured.inserted.push(args.p_rows);
        return Promise.resolve({ data: true, error: null });
      }

      captured.publishAttempts += 1;
      if (!current) return Promise.resolve({ data: [], error: null });
      const rows = [...staged.values()].flat();
      if (rows.length !== args.p_expected_rows) throw new Error("conferência incompleta no teste");
      const counts = {
        total_rows: rows.length,
        ok_rows: rows.filter((row) => row.status === "OK").length,
        skipped_rows: rows.filter((row) => row.status === "SKIPPED").length,
        invalid_rows: rows.filter((row) => row.status === "INVALID").length,
      };
      const values = { ...counts, status: "PARSED", parsed_at: args.p_parsed_at ?? null, last_error: null };
      const error = options.updateError?.(values) ?? null;
      if (error !== null) return Promise.resolve({ data: null, error });

      captured.updates.push(values);
      batch = { ...batch, ...values };
      staged.clear();
      return Promise.resolve({ data: [counts], error: null });
    },
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
  it("descarta uma leitura válida quando a segunda tentativa já publicou a conferência", async () => {
    const { deps, captured, lines } = fakeDeps({});
    const firstReading = Promise.withResolvers<undefined>();
    const finishFirst = Promise.withResolvers<readonly (readonly unknown[])[]>();
    vi.spyOn(deps.reader, "read").mockImplementationOnce(() => {
      firstReading.resolve(undefined);
      return finishFirst.promise;
    });
    const handler = createErpImportParseHandler(deps);
    const first = handler(ENVELOPE, ctx(lines, { batchId: BATCH }));
    await firstReading.promise;

    let newer;
    try {
      newer = await handler({ ...ENVELOPE, attempt: 2 }, ctx(lines, { batchId: BATCH }));
    } finally {
      finishFirst.resolve(STOCK_SHEET.slice(0, 2));
    }

    expect(newer).toEqual({ status: "done", processed: 2 });
    expect(await first).toMatchObject({ status: "failed", retryable: true });
    expect(captured.updates.at(-1)).toMatchObject({ status: "PARSED", total_rows: 2 });
    expect(captured.inserted).toHaveLength(1);
  });

  it.each(["erro de bucket", "planilha sem cabeçalho"])("preserva o lote conferido depois de %s de uma tentativa antiga", async (failure) => {
    const { deps, captured, lines } = fakeDeps({});
    const firstReading = Promise.withResolvers<undefined>();
    const finishFirst = Promise.withResolvers<readonly (readonly unknown[])[]>();
    vi.spyOn(deps.reader, "read").mockImplementationOnce(() => {
      firstReading.resolve(undefined);
      return finishFirst.promise;
    });
    const handler = createErpImportParseHandler(deps);
    const first = handler(ENVELOPE, ctx(lines, { batchId: BATCH }));
    await firstReading.promise;

    let newer;
    try {
      newer = await handler({ ...ENVELOPE, attempt: 2 }, ctx(lines, { batchId: BATCH }));
    } finally {
      if (failure === "erro de bucket") finishFirst.reject(new Error("bucket fora do ar"));
      else finishFirst.resolve([]);
    }
    const older = await first;

    expect(newer).toEqual({ status: "done", processed: 2 });
    expect(older).toMatchObject({ status: "failed", retryable: true });
    expect(captured.updates.at(-1)).toMatchObject({ status: "PARSED", total_rows: 2 });
    expect(captured.updates.some((update) => update.status === "FAILED")).toBe(false);
    expect(captured.inserted).toHaveLength(1);
  });

  it.each([
    ["UPLOADED", "APPLYING"],
    ["PARSING", "PARSING"],
  ])("preserva staging quando %s ficou desatualizado e o banco já mostra %s", async (status, newStatus) => {
    const { deps, captured, lines } = fakeDeps({
      status,
      batchStateAfterRead: { status: newStatus, updatedAt: "2026-08-20T11:59:01.000Z" },
    });
    const read = vi.spyOn(deps.reader, "read");

    const outcome = await createErpImportParseHandler(deps)(ENVELOPE, ctx(lines, { batchId: BATCH }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(read).not.toHaveBeenCalled();
    expect(captured.updates).toEqual([]);
    expect(captured.publishAttempts).toBe(0);
    expect(captured.inserted).toEqual([]);
  });

  it.each([
    { status: "PARSED" },
    { status: "CANCELLED" },
    { status: "FAILED", parsedAt: BATCH_VERSION },
  ])("preserva lote $status numa entrega tardia", async (fixture) => {
    const { deps, captured, lines } = fakeDeps(fixture);
    const read = vi.spyOn(deps.reader, "read");

    const outcome = await createErpImportParseHandler(deps)(ENVELOPE, ctx(lines, { batchId: BATCH }));

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(read).not.toHaveBeenCalled();
    expect(captured.updates).toEqual([]);
    expect(captured.publishAttempts).toBe(0);
    expect(captured.inserted).toEqual([]);
  });

  it.each(["PARSING", "FAILED"])("recupera lote %s cuja leitura ficou incompleta", async (status) => {
    const { deps, captured, lines } = fakeDeps({ status });
    const outcome = await createErpImportParseHandler(deps)(ENVELOPE, ctx(lines, { batchId: BATCH }));

    expect(outcome).toEqual({ status: "done", processed: 2 });
    expect(captured.updates.at(-1)).toMatchObject({ status: "PARSED" });
  });

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

  it("publica uma vez depois de enviar uma planilha em blocos de até mil linhas", async () => {
    const sheet = [...STOCK_SHEET, ...Array.from({ length: 500 }, () => STOCK_SHEET.slice(1)).flat()];
    const { deps, captured, lines } = fakeDeps({ sheet });

    const outcome = await createErpImportParseHandler(deps)(ENVELOPE, ctx(lines, { batchId: BATCH }));

    expect(captured.inserted.map((chunk) => chunk.length)).toEqual([1_000, 2]);
    expect(captured.publishAttempts).toBe(1);
    expect(outcome).toEqual({ status: "done", processed: 1_002 });
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

  it("D-746: lote em APPLYING não é reprocessado nem tem staging apagado", async () => {
    const { deps, captured, lines } = fakeDeps({ status: "APPLYING" });

    const outcome = await createErpImportParseHandler(deps)(ENVELOPE, ctx(lines, { batchId: BATCH }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(captured.publishAttempts).toBe(0);
    expect(captured.updates).toEqual([]);
    expect(captured.inserted).toHaveLength(0);
  });

  it("falha transitória num bloco impede publicar uma conferência parcial", async () => {
    const sheet = [...STOCK_SHEET, ...Array.from({ length: 500 }, () => STOCK_SHEET.slice(1)).flat()];
    const { deps, captured, lines } = fakeDeps({ sheet, stageFailsOffset: 1_000 });

    const outcome = await createErpImportParseHandler(deps)(ENVELOPE, ctx(lines, { batchId: BATCH }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true, reason: "bloco indisponível" });
    expect(captured.inserted.map((chunk) => chunk.length)).toEqual([1_000]);
    expect(captured.publishAttempts).toBe(0);
  });

  it("D-746: falha transitória na gravação final de PARSED retorna retryable em vez de done", async () => {
    const { deps, lines } = fakeDeps({
      updateError: (values) => (values.status === "PARSED" ? { message: "statement timeout" } : null),
    });

    const outcome = await createErpImportParseHandler(deps)(ENVELOPE, ctx(lines, { batchId: BATCH }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true, reason: "statement timeout" });
  });
});
