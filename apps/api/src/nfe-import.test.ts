import { createLogger } from "@sb/observability";
import { describe, expect, it, vi } from "vitest";

import type { Caller } from "./auth.js";
import type { NfeImportDeps } from "./nfe-import.js";
import { confirmNfeApply, MAX_NFE_UPLOAD_BYTES, receiveNfeUpload } from "./nfe-import.js";

const CALLER: Caller = {
  userId: "aaaaaaaa-0000-4000-8000-000000000001",
  organizationId: "11111111-0000-4000-8000-000000000001",
  role: "ADMIN",
};

const FILE = {
  fileName: "nfe-plasmoto.xml",
  contentType: "text/xml",
  body: new TextEncoder().encode("<nfeProc>conteudo do xml</nfeProc>"),
};

/**
 * Fake mínimo do cliente Supabase — mesmo raciocínio de erp-import.test.ts:
 * testar a decisão de fluxo, não o Postgres real (isso é papel dos testes de
 * integração de `@sb/db`).
 */
function fakeDb(options: { existingDocumentId?: string; insertFails?: boolean }): {
  db: NfeImportDeps["db"];
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
                data: options.existingDocumentId === undefined ? null : { id: options.existingDocumentId },
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
                  : { data: { id: "d1000000-0000-4000-8000-00000000000d" }, error: null },
              ),
          }),
        };
      },
    }),
  } as unknown as NfeImportDeps["db"];

  return { db, inserted };
}

function deps(
  options: { existingDocumentId?: string; insertFails?: boolean; uploadFails?: boolean } = {},
): {
  deps: NfeImportDeps;
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
      now: () => new Date("2026-08-22T12:00:00.000Z"),
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
              enqueuedAt: "2026-08-22T12:00:00.000Z",
            },
          });
        },
      },
    },
  };
}

describe("receiveNfeUpload", () => {
  it("guarda o arquivo, registra o documento e enfileira o parse", async () => {
    const ctx = deps();

    const result = await receiveNfeUpload(ctx.deps, CALLER, FILE);

    expect(result.status).toBe("created");
    expect(ctx.uploads).toHaveLength(1);
    expect(ctx.enqueued).toEqual([
      { jobType: "nfe.import.parse", dedupeKey: "nfe-parse:d1000000-0000-4000-8000-00000000000d" },
    ]);
  });

  it("o caminho no bucket é derivado do conteúdo, extensão .xml", async () => {
    const ctx = deps();

    await receiveNfeUpload(ctx.deps, CALLER, FILE);

    expect(ctx.uploads[0]?.path).toMatch(
      /^11111111-0000-4000-8000-000000000001\/2026-08\/[0-9a-f]{64}\.xml$/,
    );
  });

  it("o mesmo conteúdo sempre gera o mesmo hash", async () => {
    const a = await receiveNfeUpload(deps().deps, CALLER, FILE);
    const b = await receiveNfeUpload(deps().deps, CALLER, { ...FILE, fileName: "outro-nome.xml" });

    expect(a.status === "created" && a.contentHash).toBe(b.status === "created" && b.contentHash);
  });

  it("documento já importado NÃO é gravado de novo nem reenfileirado", async () => {
    const ctx = deps({ existingDocumentId: "doc-antigo" });

    const result = await receiveNfeUpload(ctx.deps, CALLER, FILE);

    expect(result).toMatchObject({ status: "duplicate", documentId: "doc-antigo" });
    expect(ctx.uploads).toHaveLength(0);
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("recusa arquivo vazio", async () => {
    const ctx = deps();

    const result = await receiveNfeUpload(ctx.deps, CALLER, { ...FILE, body: new Uint8Array(0) });

    expect(result).toMatchObject({ status: "rejected" });
    expect(ctx.uploads).toHaveLength(0);
  });

  it("recusa arquivo acima do limite antes de calcular hash ou gravar", async () => {
    const ctx = deps();

    const result = await receiveNfeUpload(ctx.deps, CALLER, {
      ...FILE,
      body: new Uint8Array(MAX_NFE_UPLOAD_BYTES + 1),
    });

    expect(result).toMatchObject({ status: "rejected" });
    expect(ctx.uploads).toHaveLength(0);
  });

  it("não enfileira parse quando o documento não é registrado", async () => {
    const ctx = deps({ insertFails: true });

    const result = await receiveNfeUpload(ctx.deps, CALLER, FILE);

    expect(result).toMatchObject({ status: "rejected" });
    expect(ctx.enqueued).toHaveLength(0);
    expect(ctx.lines.join()).toContain("nfe_import_document_not_created");
  });

  it("falha do bucket interrompe antes de registrar o documento", async () => {
    const ctx = deps({ uploadFails: true });

    await expect(receiveNfeUpload(ctx.deps, CALLER, FILE)).rejects.toThrow(/bucket/);
    expect(ctx.inserted).not.toHaveBeenCalled();
  });

  it("grava quem enviou", async () => {
    const ctx = deps();

    await receiveNfeUpload(ctx.deps, CALLER, FILE);

    expect(ctx.inserted).toHaveBeenCalledWith(expect.objectContaining({ uploaded_by: CALLER.userId }));
  });
});

/** Fake para `confirmNfeApply`: cadeia `select().eq().eq().maybeSingle()` e `update().eq().eq()`. */
function applyDb(options: {
  status?: string;
  missing?: boolean;
  updateFails?: boolean;
  totalItems?: number | null;
  resolvedItems?: number | null;
}): {
  db: NfeImportDeps["db"];
  updates: Record<string, unknown>[];
} {
  const updates: Record<string, unknown>[] = [];

  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data:
                  options.missing === true
                    ? null
                    : {
                        id: "doc-1",
                        status: options.status ?? "PARSED",
                        total_items: "totalItems" in options ? options.totalItems : 19,
                        resolved_items: "resolvedItems" in options ? options.resolvedItems : 19,
                      },
                error: null,
              }),
          }),
        }),
      }),
      update: (values: Record<string, unknown>) => {
        updates.push(values);

        return {
          eq: () => ({
            eq: () =>
              Promise.resolve(
                options.updateFails === true ? { error: { message: "boom" } } : { error: null },
              ),
          }),
        };
      },
    }),
  } as unknown as NfeImportDeps["db"];

  return { db, updates };
}

function applyDeps(
  options: {
    status?: string;
    missing?: boolean;
    updateFails?: boolean;
    totalItems?: number | null;
    resolvedItems?: number | null;
  } = {},
): { deps: NfeImportDeps; enqueued: { dedupeKey: string; jobType: string }[]; updates: Record<string, unknown>[] } {
  const { db, updates } = applyDb(options);
  const enqueued: { dedupeKey: string; jobType: string }[] = [];

  return {
    updates,
    enqueued,
    deps: {
      db,
      logger: createLogger({}, { sink: () => undefined }),
      store: { upload: () => Promise.resolve() },
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
              enqueuedAt: "2026-08-22T12:00:00.000Z",
            },
          });
        },
      },
    },
  };
}

describe("confirmNfeApply", () => {
  it("confirma um documento PARSED com todos os itens vinculados: marca APPLYING e enfileira", async () => {
    const ctx = applyDeps();

    const outcome = await confirmNfeApply(ctx.deps, CALLER, "doc-1");

    expect(outcome).toEqual({ status: "queued", documentId: "doc-1" });
    expect(ctx.updates).toEqual([{ status: "APPLYING", applied_by: CALLER.userId }]);
    expect(ctx.enqueued).toEqual([{ jobType: "nfe.import.apply", dedupeKey: "nfe-apply:doc-1" }]);
  });

  it("itens ainda não 100% vinculados: recusa, não enfileira", async () => {
    const ctx = applyDeps({ totalItems: 19, resolvedItems: 17 });

    const outcome = await confirmNfeApply(ctx.deps, CALLER, "doc-1");

    expect(outcome).toMatchObject({ status: "rejected" });
    expect("reason" in outcome ? outcome.reason : "").toContain("17");
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("documento sem nenhum item (total_items zero) é recusado — nada a aplicar", async () => {
    const ctx = applyDeps({ totalItems: 0, resolvedItems: 0 });

    const outcome = await confirmNfeApply(ctx.deps, CALLER, "doc-1");

    expect(outcome).toMatchObject({ status: "rejected" });
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("documento inexistente ou de outra organização não é confirmado", async () => {
    const ctx = applyDeps({ missing: true });

    const outcome = await confirmNfeApply(ctx.deps, CALLER, "doc-1");

    expect(outcome).toEqual({ status: "not_found" });
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("documento que não está PARSED é recusado", async () => {
    const ctx = applyDeps({ status: "APPLYING" });

    const outcome = await confirmNfeApply(ctx.deps, CALLER, "doc-1");

    expect(outcome).toMatchObject({ status: "rejected" });
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("documento já aplicado é recusado", async () => {
    const ctx = applyDeps({ status: "APPLIED" });

    const outcome = await confirmNfeApply(ctx.deps, CALLER, "doc-1");

    expect(outcome).toMatchObject({ status: "rejected" });
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("falha ao gravar a confirmação não enfileira a aplicação", async () => {
    const ctx = applyDeps({ updateFails: true });

    const outcome = await confirmNfeApply(ctx.deps, CALLER, "doc-1");

    expect(outcome).toMatchObject({ status: "rejected" });
    expect(ctx.enqueued).toHaveLength(0);
  });
});
