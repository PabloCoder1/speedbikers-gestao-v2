import { createHash } from "node:crypto";

import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";

import type { Caller } from "./auth.js";
import type { Enqueuer } from "./enqueue.js";
import type { FileStore } from "./erp-import.js";

/**
 * Recepção do XML da NF-e.
 *
 * Mesmo fluxo do importador do UpSeller (`docs/PROMPT_MASTER.md` secao 13,
 * `apps/api/src/erp-import.ts`):
 *
 *   upload -> parse -> CONFERENCIA -> confirmação humana -> aplicação
 *
 * Esta peça cobre upload e confirmação — o parse é `nfe.import.parse`
 * (worker), já implementado; a aplicação é `nfe.import.apply` (worker),
 * enfileirada por `confirmNfeApply` abaixo.
 */

/**
 * Teto de tamanho do arquivo.
 *
 * Bem menor que `MAX_UPLOAD_BYTES` do importador do UpSeller: uma NF-e é um
 * documento por nota, não uma planilha com milhares de linhas. O XML real
 * usado para desenhar o parser (19 itens) tem poucos KB — 5 MB já é folga
 * generosa para uma nota com centenas de itens.
 */
export const MAX_NFE_UPLOAD_BYTES = 5 * 1024 * 1024;

export interface NfeUploadRequest {
  fileName: string;
  contentType: string;
  body: Uint8Array;
}

export type NfeUploadOutcome =
  | { status: "created"; documentId: string; contentHash: string }
  | { status: "duplicate"; documentId: string; contentHash: string }
  | { status: "rejected"; reason: string };

export interface NfeImportDeps {
  db: AdminClient;
  store: FileStore;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export async function receiveNfeUpload(
  deps: NfeImportDeps,
  caller: Caller,
  request: NfeUploadRequest,
): Promise<NfeUploadOutcome> {
  if (request.body.byteLength === 0) {
    return { status: "rejected", reason: "arquivo vazio" };
  }

  if (request.body.byteLength > MAX_NFE_UPLOAD_BYTES) {
    return { status: "rejected", reason: "arquivo acima do limite aceito" };
  }

  const contentHash = createHash("sha256").update(request.body).digest("hex");

  // Idempotência ANTES de gravar — mesmo raciocínio de receiveUpload
  // (erp-import.ts): a checagem evita que um reenvio gaste armazenamento e só
  // falhe no INSERT, depois do arquivo já estar no bucket.
  const existing = await deps.db
    .from("documents")
    .select("id")
    .eq("organization_id", caller.organizationId)
    .eq("content_hash", contentHash)
    .maybeSingle();

  if (existing.data !== null) {
    deps.logger.info("nfe_import_duplicate", {
      content_hash: contentHash,
      document_id: existing.data.id,
    });

    return { status: "duplicate", documentId: existing.data.id, contentHash };
  }

  const now = deps.now?.() ?? new Date();
  const month = now.toISOString().slice(0, 7);

  // Caminho endereçado pelo conteúdo, mesmo motivo de erp-import.ts.
  const storagePath = `${caller.organizationId}/${month}/${contentHash}.xml`;

  await deps.store.upload(storagePath, request.body, request.contentType);

  const inserted = await deps.db
    .from("documents")
    .insert({
      organization_id: caller.organizationId,
      storage_path: storagePath,
      file_name: request.fileName,
      content_hash: contentHash,
      uploaded_by: caller.userId,
    })
    .select("id")
    .single();

  if (inserted.error !== null) {
    // O arquivo já está no bucket, mas o caminho é derivado do hash — uma
    // nova tentativa reaproveita o mesmo objeto, não cria lixo.
    deps.logger.error("nfe_import_document_not_created", {
      content_hash: contentHash,
      reason: inserted.error.message,
    });

    return { status: "rejected", reason: "não foi possível registrar o documento" };
  }

  const documentId = inserted.data.id;

  await deps.enqueuer.enqueue({
    jobType: "nfe.import.parse",
    organizationId: caller.organizationId,
    // Um parse por documento. Reenviar a notificação não duplica trabalho.
    dedupeKey: `nfe-parse:${documentId}`,
    queue: "maintenance",
    payload: { documentId },
  });

  deps.logger.info("nfe_import_received", {
    document_id: documentId,
    bytes: request.body.byteLength,
    content_hash: contentHash,
  });

  return { status: "created", documentId, contentHash };
}

/**
 * Confirmação humana: move o documento conferido para aplicação.
 *
 * Diferente de `confirmApply` (erp-import.ts): exige que TODOS os itens
 * estejam vinculados (`resolved_items === total_items`) antes de liberar a
 * aplicação. Uma NF-e é um documento fiscal fechado — aplicar parcialmente
 * geraria estoque físico recebido/enviado sem nenhum registro, silenciosamente,
 * e sem o mecanismo de resolução automática futura que o importador do
 * UpSeller tem (Central de Vinculações). O UpSeller tolera `UNRESOLVED`
 * porque uma importação futura pode resolver sozinha; um documento de NF-e
 * não tem uma "futura importação" equivalente — o vínculo é por documento,
 * feito uma vez, na própria conferência (`docs/NFE.md` secao 3).
 */

export type ConfirmNfeApplyOutcome =
  | { status: "queued"; documentId: string }
  | { status: "not_found" }
  | { status: "rejected"; reason: string };

export async function confirmNfeApply(
  deps: NfeImportDeps,
  caller: Caller,
  documentId: string,
): Promise<ConfirmNfeApplyOutcome> {
  const document = await deps.db
    .from("documents")
    .select("id, status, total_items, resolved_items")
    .eq("id", documentId)
    .eq("organization_id", caller.organizationId)
    .maybeSingle();

  if (document.error !== null || document.data === null) {
    return { status: "not_found" };
  }

  if (document.data.status !== "PARSED") {
    return { status: "rejected", reason: `documento em ${document.data.status}, não está pronto para aplicação` };
  }

  const total = document.data.total_items ?? 0;
  const resolved = document.data.resolved_items ?? 0;

  if (total === 0 || resolved < total) {
    return {
      status: "rejected",
      reason: `${String(resolved)} de ${String(total)} itens vinculados — vincule todos antes de confirmar`,
    };
  }

  const updated = await deps.db
    .from("documents")
    .update({ status: "APPLYING", applied_by: caller.userId })
    .eq("id", documentId)
    .eq("status", "PARSED");

  if (updated.error !== null) {
    deps.logger.error("nfe_apply_not_confirmed", { document_id: documentId, reason: updated.error.message });

    return { status: "rejected", reason: "não foi possível confirmar a aplicação" };
  }

  await deps.enqueuer.enqueue({
    jobType: "nfe.import.apply",
    organizationId: caller.organizationId,
    // Uma aplicação por documento. Reconfirmar não duplica trabalho.
    dedupeKey: `nfe-apply:${documentId}`,
    queue: "maintenance",
    payload: { documentId },
  });

  deps.logger.info("nfe_apply_confirmed", { document_id: documentId, confirmed_by: caller.userId });

  return { status: "queued", documentId };
}
