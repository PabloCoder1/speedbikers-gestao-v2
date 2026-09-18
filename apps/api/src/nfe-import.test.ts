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
interface ExistingDocument {
  id: string;
  status: string;
  parsed_at: string | null;
}

function fakeDb(options: {
  existingDocumentId?: string;
  existing?: ExistingDocument;
  insertFails?: boolean;
  /** O `update ... where status = 'FAILED'` não acha a linha: outro reenvio chegou antes. */
  retryLosesRace?: boolean;
}): {
  db: NfeImportDeps["db"];
  inserted: ReturnType<typeof vi.fn>;
  updated: ReturnType<typeof vi.fn>;
} {
  const inserted = vi.fn();
  const updated = vi.fn();

  // `existingDocumentId` sozinho é o duplicado de sempre: um documento que foi lido.
  const existing: ExistingDocument | null =
    options.existing ??
    (options.existingDocumentId === undefined
      ? null
      : { id: options.existingDocumentId, status: "PARSED", parsed_at: "2026-08-22T11:00:00.000Z" });

  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: existing, error: null }),
          }),
        }),
      }),
      update: (row: unknown) => {
        updated(row);

        return {
          eq: () => ({
            eq: () => ({
              select: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: options.retryLosesRace === true || existing === null ? null : { id: existing.id },
                    error: null,
                  }),
              }),
            }),
          }),
        };
      },
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

  return { db, inserted, updated };
}

function deps(
  options: Parameters<typeof fakeDb>[0] & { uploadFails?: boolean } = {},
): {
  deps: NfeImportDeps;
  uploads: { path: string }[];
  enqueued: { dedupeKey: string; jobType: string }[];
  lines: string[];
  inserted: ReturnType<typeof vi.fn>;
  updated: ReturnType<typeof vi.fn>;
} {
  const uploads: { path: string }[] = [];
  const enqueued: { dedupeKey: string; jobType: string }[] = [];
  const lines: string[] = [];
  const { db, inserted, updated } = fakeDb(options);

  return {
    uploads,
    enqueued,
    lines,
    inserted,
    updated,
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

  /**
   * O caso de produção de 18/09/2026: o PDF entrou pela api antiga com
   * extensão .xml e a leitura falhou. Reenviar o MESMO arquivo tem de ler de
   * novo, no caminho certo — senão o hash prende o documento no erro.
   */
  it("reenviar arquivo cuja leitura falhou lê de novo, no caminho do formato certo", async () => {
    const ctx = deps({ existing: { id: "doc-falhou", status: "FAILED", parsed_at: null } });

    const result = await receiveNfeUpload(ctx.deps, CALLER, {
      fileName: "NFE-4226.pdf",
      contentType: "application/pdf",
      body: PDF_DANFE,
    });

    expect(result).toMatchObject({ status: "retried", documentId: "doc-falhou" });
    expect(ctx.uploads[0]?.path.endsWith(".pdf")).toBe(true);
    expect(ctx.updated).toHaveBeenCalledWith(
      expect.objectContaining({ status: "UPLOADED", source_format: "PDF", last_error: null }),
    );
    expect(ctx.inserted).not.toHaveBeenCalled();
    // Chave NOVA: a do primeiro parse (`nfe-parse:<id>`) já foi usada na fila.
    expect(ctx.enqueued).toEqual([
      { jobType: "nfe.import.parse", dedupeKey: "nfe-parse:doc-falhou:2026-08-22T12:00:00.000Z" },
    ]);
  });

  it("falha na APLICAÇÃO não relê: os vínculos humanos ficam como estão", async () => {
    const ctx = deps({
      existing: { id: "doc-aplicacao", status: "FAILED", parsed_at: "2026-08-22T11:00:00.000Z" },
    });

    const result = await receiveNfeUpload(ctx.deps, CALLER, FILE);

    expect(result).toMatchObject({ status: "duplicate", documentId: "doc-aplicacao" });
    expect(ctx.updated).not.toHaveBeenCalled();
    expect(ctx.enqueued).toHaveLength(0);
  });

  it("dois reenvios juntos: quem não acha a linha em FAILED não enfileira de novo", async () => {
    const ctx = deps({ existing: { id: "doc-falhou", status: "FAILED", parsed_at: null }, retryLosesRace: true });

    const result = await receiveNfeUpload(ctx.deps, CALLER, FILE);

    expect(result).toMatchObject({ status: "duplicate", documentId: "doc-falhou" });
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
    // XML de verdade, só grande: o limite é sobre o tamanho, não sobre o formato.
    const grande = new Uint8Array(MAX_NFE_UPLOAD_BYTES + 1).fill(0x20);

    grande.set(new TextEncoder().encode("<nfeProc>"), 0);

    const result = await receiveNfeUpload(ctx.deps, CALLER, { ...FILE, body: grande });

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
  documentType?: string;
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
                        document_type: options.documentType ?? "NFE",
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
    documentType?: string;
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

const PDF_DANFE = new TextEncoder().encode("%PDF-1.7\n1 0 obj\nstream\nBT (DANFE) Tj ET\nendstream");

describe("XML e PDF (D-375)", () => {
  it("PDF é aceito e guardado com extensão .pdf — o formato sai dos bytes", async () => {
    const ctx = deps();

    const result = await receiveNfeUpload(ctx.deps, CALLER, {
      fileName: "Imprimir - UpSeller.pdf",
      contentType: "application/pdf",
      body: PDF_DANFE,
    });

    expect(result.status).toBe("created");
    expect(ctx.uploads[0]?.path.endsWith(".pdf")).toBe(true);
    expect(ctx.inserted).toHaveBeenCalledWith(expect.objectContaining({ source_format: "PDF" }));
  });

  /**
   * O nome não decide: um PDF renomeado para `.xml` continua sendo PDF, e o
   * caminho no bucket tem de dizer a verdade — é a extensão que faz o worker
   * escolher o leitor.
   */
  it("PDF renomeado para .xml continua sendo lido como PDF", async () => {
    const ctx = deps();

    await receiveNfeUpload(ctx.deps, CALLER, {
      fileName: "nota.xml",
      contentType: "text/xml",
      body: PDF_DANFE,
    });

    expect(ctx.uploads[0]?.path.endsWith(".pdf")).toBe(true);
  });

  it("XML continua XML e mantém a extensão .xml", async () => {
    const ctx = deps();

    await receiveNfeUpload(ctx.deps, CALLER, FILE);

    expect(ctx.uploads[0]?.path.endsWith(".xml")).toBe(true);
    expect(ctx.inserted).toHaveBeenCalledWith(expect.objectContaining({ source_format: "XML" }));
  });

  it("arquivo que não é XML nem PDF é recusado ANTES de ocupar o bucket", async () => {
    const ctx = deps();

    const result = await receiveNfeUpload(ctx.deps, CALLER, {
      fileName: "planilha.xlsx",
      contentType: "application/vnd.ms-excel",
      body: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
    });

    expect(result).toMatchObject({ status: "rejected" });
    expect(ctx.uploads).toHaveLength(0);
  });

  it("envio ao Full não é confirmado: transferência não é saída (D-352)", async () => {
    const ctx = applyDeps({ documentType: "ENVIO_FULL_ML_PDF" });

    const result = await confirmNfeApply(ctx.deps, CALLER, "doc-1");

    expect(result).toMatchObject({ status: "rejected" });
    expect(ctx.enqueued).toHaveLength(0);
    expect(ctx.updates).toHaveLength(0);
  });
});
