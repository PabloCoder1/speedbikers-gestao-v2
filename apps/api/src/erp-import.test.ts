import { createLogger } from "@sb/observability";
import { describe, expect, it, vi } from "vitest";

import type { Caller } from "./auth.js";
import type { ImportDeps } from "./erp-import.js";
import { isImportKind, MAX_UPLOAD_BYTES, receiveUpload } from "./erp-import.js";

const CALLER: Caller = {
  userId: "aaaaaaaa-0000-4000-8000-000000000001",
  organizationId: "11111111-0000-4000-8000-000000000001",
  role: "ADMIN",
};

const FILE = {
  kind: "PRODUCTS" as const,
  fileName: "export_warehouse_products.xlsx",
  contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  body: new TextEncoder().encode("conteudo da planilha"),
};

/**
 * Fake mínimo do cliente Supabase, cobrindo só o encadeamento que o código usa.
 * Testar a `api` contra um Postgres real é papel dos testes de integração de
 * `@sb/db`; aqui o que está sob teste é a decisão de fluxo.
 */
function fakeDb(options: { existingBatchId?: string; insertFails?: boolean }): {
  db: ImportDeps["db"];
  inserted: ReturnType<typeof vi.fn>;
} {
  const inserted = vi.fn();

  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: options.existingBatchId === undefined ? null : { id: options.existingBatchId },
                error: null,
              }),
          }),
        }),
      }),
      insert: (row: unknown) => {
        inserted(row);

        return {
          select: () => ({
            single: () =>
              Promise.resolve(
                options.insertFails === true
                  ? { data: null, error: { message: "boom" } }
                  : { data: { id: "b1000000-0000-4000-8000-00000000000b" }, error: null },
              ),
          }),
        };
      },
    }),
  } as unknown as ImportDeps["db"];

  return { db, inserted };
}

function deps(
  options: { existingBatchId?: string; insertFails?: boolean; uploadFails?: boolean } = {},
): {
  deps: ImportDeps;
  uploads: { path: string }[];
  enqueued: { dedupeKey: string; jobType: string }[];
  lines: string[];
  inserted: ReturnType<typeof vi.fn>;
} {
  const uploads: { path: string }[] = [];
  const enqueued: { dedupeKey: string; jobType: string }[] = [];
  const lines: string[] = [];
  const { db, inserted } = fakeDb(options);

  return {
    uploads,
    enqueued,
    lines,
    inserted,
    deps: {
      db,
      logger: createLogger({}, { sink: (line) => lines.push(line) }),
      now: () => new Date("2026-08-20T12:00:00.000Z"),
      store: {
        upload: (path) => {
          if (options.uploadFails === true) {
            return Promise.reject(new Error("bucket fora do ar"));
          }

          uploads.push({ path });

          return Promise.resolve();
        },
      },
      enqueuer: {
        enqueue: (request) => {
          enqueued.push({ dedupeKey: request.dedupeKey, jobType: request.jobType });

          return Promise.resolve({
            taskName: "t",
            deduplicated: false,
            envelope: {
              jobType: request.jobType,
              jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
              organizationId: request.organizationId,
              dedupeKey: request.dedupeKey,
              attempt: 1,
              enqueuedAt: "2026-08-20T12:00:00.000Z",
            },
          });
        },
      },
    },
  };
}

describe("isImportKind", () => {
  it.each(["PRODUCTS", "KITS", "LINKS", "STOCK"])("aceita %s", (kind) => {
    expect(isImportKind(kind)).toBe(true);
  });

  it.each(["PRODUTOS", "products", "", null])("recusa %s", (kind) => {
    expect(isImportKind(kind)).toBe(false);
  });
});

describe("receiveUpload", () => {
  it("guarda o arquivo, registra o lote e enfileira o parse", async () => {
    const ctx = deps();

    const result = await receiveUpload(ctx.deps, CALLER, FILE);

    expect(result.status).toBe("created");
    expect(ctx.uploads).toHaveLength(1);
    expect(ctx.enqueued).toEqual([
      { jobType: "erp.import.parse", dedupeKey: "erp-parse:b1000000-0000-4000-8000-00000000000b" },
    ]);
  });

  it("o caminho no bucket é derivado do conteúdo, não do nome do arquivo", async () => {
    // Reenviar o mesmo conteúdo com outro nome cai no mesmo objeto, em vez de
    // acumular cópias órfãs.
    const ctx = deps();

    await receiveUpload(ctx.deps, CALLER, FILE);

    expect(ctx.uploads[0]?.path).toMatch(
      /^11111111-0000-4000-8000-000000000001\/2026-08\/[0-9a-f]{64}\.xlsx$/,
    );
  });

  it("o mesmo conteúdo sempre gera o mesmo hash", async () => {
    const a = await receiveUpload(deps().deps, CALLER, FILE);
    const b = await receiveUpload(deps().deps, CALLER, { ...FILE, fileName: "outro-nome.xlsx" });

    expect(a.status === "created" && a.contentHash).toBe(b.status === "created" && b.contentHash);
  });

  it("arquivo já importado NÃO é gravado de novo nem reenfileirado", async () => {
    // A checagem acontece antes de tocar o bucket: falhar só no INSERT
    // desperdiçaria armazenamento.
    const ctx = deps({ existingBatchId: "batch-antigo" });

    const result = await receiveUpload(ctx.deps, CALLER, FILE);

    expect(result).toMatchObject({ status: "duplicate", batchId: "batch-antigo" });
    expect(ctx.uploads).toHaveLength(0);
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("recusa arquivo vazio", async () => {
    const ctx = deps();

    const result = await receiveUpload(ctx.deps, CALLER, { ...FILE, body: new Uint8Array(0) });

    expect(result).toMatchObject({ status: "rejected" });
    expect(ctx.uploads).toHaveLength(0);
  });

  it("recusa arquivo acima do limite antes de calcular hash ou gravar", async () => {
    const ctx = deps();

    const result = await receiveUpload(ctx.deps, CALLER, {
      ...FILE,
      body: new Uint8Array(MAX_UPLOAD_BYTES + 1),
    });

    expect(result).toMatchObject({ status: "rejected" });
    expect(ctx.uploads).toHaveLength(0);
  });

  it("não enfileira parse quando o lote não é registrado", async () => {
    // Enfileirar apontando para um lote que não existe faria o worker falhar
    // repetidamente sem causa visível.
    const ctx = deps({ insertFails: true });

    const result = await receiveUpload(ctx.deps, CALLER, FILE);

    expect(result).toMatchObject({ status: "rejected" });
    expect(ctx.enqueued).toHaveLength(0);
    expect(ctx.lines.join()).toContain("erp_import_batch_not_created");
  });

  it("falha do bucket interrompe antes de registrar o lote", async () => {
    const ctx = deps({ uploadFails: true });

    await expect(receiveUpload(ctx.deps, CALLER, FILE)).rejects.toThrow(/bucket/);
    expect(ctx.inserted).not.toHaveBeenCalled();
  });

  it("grava quem enviou — importação é ato administrativo auditável", async () => {
    const ctx = deps();

    await receiveUpload(ctx.deps, CALLER, FILE);

    expect(ctx.inserted).toHaveBeenCalledWith(
      expect.objectContaining({ uploaded_by: CALLER.userId, kind: "PRODUCTS" }),
    );
  });
});
