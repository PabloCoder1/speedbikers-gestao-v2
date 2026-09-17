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

/**
 * Teto do PDF — quatro vezes o do XML (D-375).
 *
 * O XML é texto; o PDF carrega fontes embutidas, logotipo e código de barras.
 * Os arquivos reais que desenharam os leitores têm centenas de KB, mas um DANFE
 * digitalizado (imagem por página) passa fácil dos 5 MB, e recusá-lo por
 * tamanho seria recusar o documento que a pessoa TEM.
 */
export const MAX_PDF_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * XML ou PDF — decidido pelos BYTES (D-375).
 *
 * O nome do arquivo não decide nada: "Imprimir - UpSeller.pdf" pode chegar
 * renomeado, e um `.xml` pode vir com o PDF dentro. O que não mente é o começo
 * do arquivo: todo PDF abre com `%PDF-`, e o XML da NF-e tem `<NFe`/`<nfeProc`.
 *
 * QUAL dos três layouts de PDF é este, isso o worker descobre lendo o texto
 * (`@sb/domain/documentos`) — aqui basta saber que é PDF.
 */
export function formatoDoArquivo(bytes: Uint8Array): "XML" | "PDF" | null {
  const inicio = Buffer.from(bytes.subarray(0, 1024)).toString("latin1").trimStart();

  if (inicio.startsWith("%PDF-")) return "PDF";

  if (/<\?xml|<nfeProc|<NFe|<enviNFe/i.test(inicio)) return "XML";

  return null;
}

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

  // O teto maior primeiro: um arquivo gigante é recusado sem que ninguém
  // precise olhar o conteúdo dele.
  if (request.body.byteLength > MAX_PDF_UPLOAD_BYTES) {
    return { status: "rejected", reason: "arquivo acima do limite aceito" };
  }

  const formato = formatoDoArquivo(request.body);

  if (formato === null) {
    return {
      status: "rejected",
      reason: "arquivo não reconhecido — envie o XML da NF-e ou o PDF do documento (DANFE, pedido de saída ou envio ao Full)",
    };
  }

  if (formato === "XML" && request.body.byteLength > MAX_NFE_UPLOAD_BYTES) {
    return { status: "rejected", reason: "XML acima do limite aceito" };
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

  // Caminho endereçado pelo conteúdo, mesmo motivo de erp-import.ts. A
  // extensão vem do formato LIDO — é ela que o worker usa para saber qual
  // leitor abre o arquivo.
  const storagePath = `${caller.organizationId}/${month}/${contentHash}.${formato === "PDF" ? "pdf" : "xml"}`;

  await deps.store.upload(storagePath, request.body, request.contentType);

  const inserted = await deps.db
    .from("documents")
    .insert({
      organization_id: caller.organizationId,
      storage_path: storagePath,
      file_name: request.fileName,
      content_hash: contentHash,
      source_format: formato,
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
    formato,
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
    .select("id, status, total_items, resolved_items, document_type")
    .eq("id", documentId)
    .eq("organization_id", caller.organizationId)
    .maybeSingle();

  if (document.error !== null || document.data === null) {
    return { status: "not_found" };
  }

  if (document.data.status !== "PARSED") {
    return { status: "rejected", reason: `documento em ${document.data.status}, não está pronto para aplicação` };
  }

  if (document.data.document_type === "ENVIO_FULL_ML_PDF") {
    /*
      Envio ao Full é TRANSFERÊNCIA, não saída: a mercadoria continua nossa, no
      centro do Mercado Livre. Gravar como saída simples faria a unidade
      desaparecer do sistema. O documento é lido e conferido; aplicar espera o
      desenho do Full (D-352).
    */
    return {
      status: "rejected",
      reason:
        "envio ao Full é transferência, não saída — o documento fica conferido, mas a baixa espera o desenho do Full (D-352)",
    };
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
