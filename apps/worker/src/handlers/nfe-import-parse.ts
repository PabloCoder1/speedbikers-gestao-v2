import type { AdminClient } from "@sb/db";
import { parseNfeXmlObject } from "@sb/domain";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";

/**
 * Parse do XML da NF-e. Segunda etapa do fluxo: `upload -> PARSE ->
 * conferência -> confirmação -> aplicação` (`docs/PROMPT_MASTER.md` secao
 * 13, mesmo formato de `erp-import-parse.ts`).
 *
 * Este handler **não gera `stock_movements`**. Ele só interpreta o XML e
 * grava `document_items` para a conferência. Todo item nasce SEM `sku_id`
 * — o vínculo é humano, na tela de conferência (`docs/NFE.md` secao 3),
 * não resolvido automaticamente aqui (diferente do UpSeller, que já tem
 * `sku_listing_links` confirmado para resolver contra).
 */

const payloadSchema = z.object({ documentId: z.uuid() });

/** Lê o arquivo do bucket e devolve o objeto já convertido de XML. Abstraído para o teste não precisar de rede. */
export interface NfeXmlReader {
  read: (storagePath: string) => Promise<unknown>;
}

export interface NfeParseDeps {
  db: AdminClient;
  reader: NfeXmlReader;
  now?: () => Date;
}

const CHUNK = 500;

export function createNfeImportParseHandler(deps: NfeParseDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem documentId" };
    }

    const { documentId } = parsed.data;

    const document = await deps.db
      .from("documents")
      .select("id, status, organization_id, storage_path")
      .eq("id", documentId)
      .maybeSingle();

    if (document.error !== null) {
      return { status: "failed", retryable: true, reason: document.error.message };
    }

    if (document.data === null) {
      return { status: "failed", retryable: false, reason: `documento ${documentId} não existe` };
    }

    if (document.data.status === "APPLIED") {
      // Reprocessar um documento já aplicado reescreveria a conferência que
      // sustentou a decisão humana — mesma regra de erp_import_batches.
      return { status: "failed", retryable: false, reason: "documento já aplicado" };
    }

    await deps.db.from("documents").update({ status: "PARSING" }).eq("id", documentId);

    let xmlObject: unknown;

    try {
      xmlObject = await deps.reader.read(document.data.storage_path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "falha ao ler o arquivo";

      await deps.db.from("documents").update({ status: "FAILED", last_error: reason }).eq("id", documentId);

      // Bucket indisponível é transitório; o documento volta a PARSING na próxima.
      return { status: "failed", retryable: true, reason };
    }

    const result = parseNfeXmlObject(xmlObject);

    if (!result.ok) {
      await deps.db
        .from("documents")
        .update({ status: "FAILED", last_error: result.reason })
        .eq("id", documentId);

      context.logger.error("nfe_parse_invalid_xml", { document_id: documentId, reason: result.reason });

      return { status: "failed", retryable: false, reason: result.reason };
    }

    const nfe = result.value;

    // Idempotência: o job pode ser reentregue. Limpar antes de inserir faz a
    // reexecução começar do zero em vez de colidir com a chave única.
    await deps.db.from("document_items").delete().eq("document_id", documentId);

    const rows = nfe.items.map((item) => ({
      document_id: documentId,
      position: item.position,
      supplier_code: item.supplierCode,
      ean: item.ean,
      description: item.description,
      ncm: item.ncm,
      cfop: item.cfop,
      unit: item.unit,
      quantity: item.quantity,
      unit_value: item.unitValue,
      total_value: item.totalValue,
      sku_id: null,
    }));

    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK);

      const inserted = await deps.db.from("document_items").insert(chunk);

      if (inserted.error !== null) {
        return { status: "failed", retryable: true, reason: inserted.error.message };
      }
    }

    await deps.db
      .from("documents")
      .update({
        status: "PARSED",
        access_key: nfe.accessKey,
        operation_type: nfe.operationType,
        document_number: nfe.documentNumber,
        series: nfe.series,
        issue_date: nfe.issueDate.toISOString(),
        issuer_cnpj: nfe.issuerCnpj,
        issuer_name: nfe.issuerName,
        total_items: rows.length,
        resolved_items: 0,
        parsed_at: (deps.now?.() ?? new Date()).toISOString(),
        last_error: null,
      })
      .eq("id", documentId);

    context.logger.info("nfe_parse_finished", {
      document_id: documentId,
      access_key: nfe.accessKey,
      operation_type: nfe.operationType,
      total_items: rows.length,
    });

    return { status: "done", processed: rows.length };
  };
}
