import { createHash } from "node:crypto";

import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";

import type { Caller } from "./auth.js";
import type { Enqueuer } from "./enqueue.js";

/**
 * Recepção do arquivo exportado do UpSeller.
 *
 * Fluxo completo (escolhido em 2026-08-20):
 *
 *   upload -> parse -> CONFERENCIA -> confirmação humana -> aplicação
 *
 * Esta peça cobre o upload: guarda o arquivo, registra o lote e enfileira o
 * parse. Ela NÃO interpreta a planilha — a `api` nunca faz trabalho longo
 * inline (docs/ARCHITECTURE.md secao 5).
 */

export const IMPORT_KINDS = ["PRODUCTS", "KITS", "LINKS", "STOCK"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export function isImportKind(value: unknown): value is ImportKind {
  return typeof value === "string" && (IMPORT_KINDS as readonly string[]).includes(value);
}

/**
 * Teto de tamanho do arquivo.
 *
 * A maior exportação real tem 23.924 linhas e fica bem abaixo disto. O limite
 * existe para o upload atravessar a `api` com segurança: acima dele, o caminho
 * correto passa a ser URL assinada com envio direto ao bucket, e não aumentar
 * este número.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Abstração mínima do bucket, para o teste não precisar de rede. */
export interface FileStore {
  upload: (path: string, body: Uint8Array, contentType: string) => Promise<void>;
}

export interface UploadRequest {
  kind: ImportKind;
  fileName: string;
  contentType: string;
  body: Uint8Array;
}

export type UploadOutcome =
  | { status: "created"; batchId: string; contentHash: string }
  | { status: "duplicate"; batchId: string; contentHash: string }
  | { status: "rejected"; reason: string };

export interface ImportDeps {
  db: AdminClient;
  store: FileStore;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export async function receiveUpload(
  deps: ImportDeps,
  caller: Caller,
  request: UploadRequest,
): Promise<UploadOutcome> {
  if (request.body.byteLength === 0) {
    return { status: "rejected", reason: "arquivo vazio" };
  }

  if (request.body.byteLength > MAX_UPLOAD_BYTES) {
    return { status: "rejected", reason: "arquivo acima do limite aceito" };
  }

  const contentHash = createHash("sha256").update(request.body).digest("hex");

  // Idempotência ANTES de gravar. Sem esta checagem o upload duplicado
  // desperdiçaria armazenamento e só falharia no INSERT, depois do arquivo já
  // estar no bucket.
  const existing = await deps.db
    .from("erp_import_batches")
    .select("id")
    .eq("organization_id", caller.organizationId)
    .eq("content_hash", contentHash)
    .maybeSingle();

  if (existing.data !== null) {
    deps.logger.info("erp_import_duplicate", {
      content_hash: contentHash,
      batch_id: existing.data.id,
    });

    return { status: "duplicate", batchId: existing.data.id, contentHash };
  }

  const now = deps.now?.() ?? new Date();
  const month = now.toISOString().slice(0, 7);

  // Caminho endereçado pelo conteúdo: o mesmo arquivo sempre cai no mesmo
  // lugar, e reenvio não cria objeto órfão.
  const storagePath = `${caller.organizationId}/${month}/${contentHash}.xlsx`;

  await deps.store.upload(storagePath, request.body, request.contentType);

  const inserted = await deps.db
    .from("erp_import_batches")
    .insert({
      organization_id: caller.organizationId,
      kind: request.kind,
      storage_path: storagePath,
      file_name: request.fileName,
      content_hash: contentHash,
      uploaded_by: caller.userId,
    })
    .select("id")
    .single();

  if (inserted.error !== null) {
    // O arquivo já está no bucket. Não é lixo: o caminho é derivado do hash,
    // então uma nova tentativa reaproveita o mesmo objeto.
    deps.logger.error("erp_import_batch_not_created", {
      content_hash: contentHash,
      reason: inserted.error.message,
    });

    return { status: "rejected", reason: "não foi possível registrar o lote" };
  }

  const batchId = inserted.data.id;

  await deps.enqueuer.enqueue({
    jobType: "erp.import.parse",
    organizationId: caller.organizationId,
    // Um parse por lote. Reenviar a notificação não duplica trabalho.
    dedupeKey: `erp-parse:${batchId}`,
    queue: "maintenance",
    payload: { batchId },
  });

  deps.logger.info("erp_import_received", {
    batch_id: batchId,
    kind: request.kind,
    bytes: request.body.byteLength,
    content_hash: contentHash,
  });

  return { status: "created", batchId, contentHash };
}
