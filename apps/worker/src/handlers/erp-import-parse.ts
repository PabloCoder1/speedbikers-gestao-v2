import type { AdminClient, Json } from "@sb/db";
import {
  buildHeaderIndex,
  KIT_COLUMNS,
  LINK_COLUMNS,
  mapKitRow,
  mapLinkRow,
  mapProductRow,
  mapStockRow,
  missingColumns,
  PRODUCT_COLUMNS,
  STOCK_COLUMNS,
} from "@sb/domain";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";

/**
 * Parse do arquivo exportado do UpSeller.
 *
 * Segunda etapa do fluxo: `upload -> PARSE -> conferência -> confirmação ->
 * aplicação`.
 *
 * Este handler **não altera catálogo, estoque nem vínculo**. Ele só interpreta
 * o arquivo e grava o resultado em `erp_import_rows` para a conferência. A
 * separação é o que permite um humano ver o que vai acontecer antes de
 * acontecer.
 */

const payloadSchema = z.object({ batchId: z.uuid() });

/** Lê o arquivo do bucket. Abstraído para o teste não precisar de rede. */
export interface SheetReader {
  read: (storagePath: string) => Promise<readonly (readonly unknown[])[]>;
}

export interface ParseDeps {
  db: AdminClient;
  reader: SheetReader;
  now?: () => Date;
}

/**
 * Tamanho do lote de inserção.
 *
 * O maior arquivo tem 23.924 linhas. Mandar tudo num INSERT só arrisca estourar
 * limite de payload; mandar uma a uma seriam 23.924 viagens de rede. Mil por
 * vez mantém as duas coisas sob controle.
 */
const CHUNK = 1000;

interface MappedRow {
  row_number: number;
  status: "OK" | "SKIPPED" | "INVALID";
  reason: string | null;
  sku_key: string | null;
  payload: Json;
}

/**
 * Converte o registro normalizado para o tipo da coluna `jsonb`.
 *
 * A conversão é segura por construção: os registros de `@sb/domain` contêm
 * apenas string, número, booleano, `null` e objetos simples — nunca `undefined`,
 * `Date` ou classe, que são justamente o que quebraria a serialização.
 * Round-trip por `JSON.stringify` daria a mesma garantia pagando CPU em 23.924
 * linhas sem necessidade.
 */
function asJson(value: object): Json {
  return value as Json;
}

function mapRows(
  kind: string,
  header: readonly unknown[],
  rows: readonly (readonly unknown[])[],
): { rows: MappedRow[]; missing: string[] } {
  const index = buildHeaderIndex(header);

  const required =
    kind === "PRODUCTS"
      ? PRODUCT_COLUMNS
      : kind === "KITS"
        ? KIT_COLUMNS
        : kind === "LINKS"
          ? LINK_COLUMNS
          : STOCK_COLUMNS;

  // Conferir o cabeçalho ANTES de processar milhares de linhas: arquivo trocado
  // deve falhar de imediato, não produzir 23.924 linhas inválidas.
  const missing = missingColumns(index, required);

  if (missing.length > 0) {
    return { rows: [], missing };
  }

  const mapped: MappedRow[] = [];

  rows.forEach((row, offset) => {
    // +2: a linha 1 é o cabeçalho e a contagem exibida ao humano começa em 1.
    const rowNumber = offset + 2;

    const result =
      kind === "PRODUCTS"
        ? mapProductRow(row, index)
        : kind === "KITS"
          ? mapKitRow(row, index)
          : kind === "LINKS"
            ? mapLinkRow(row, index)
            : mapStockRow(row, index);

    if (result.ok) {
      mapped.push({
        row_number: rowNumber,
        status: "OK",
        reason: null,
        sku_key: "skuKey" in result.value ? result.value.skuKey : null,
        payload: asJson(result.value),
      });

      return;
    }

    // `skipped` distingue decisão de erro. Descartado por D-037 é esperado e
    // não deve aparecer como problema na conferência.
    const skipped = "skipped" in result && result.skipped === true;

    mapped.push({
      row_number: rowNumber,
      status: skipped ? "SKIPPED" : "INVALID",
      reason: result.reason,
      sku_key: null,
      payload: {},
    });
  });

  return { rows: mapped, missing: [] };
}

export function createErpImportParseHandler(deps: ParseDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      // Payload malformado nunca melhora com repetição.
      return { status: "failed", retryable: false, reason: "payload sem batchId" };
    }

    const { batchId } = parsed.data;

    const batch = await deps.db
      .from("erp_import_batches")
      .select("id, kind, storage_path, status, organization_id")
      .eq("id", batchId)
      .maybeSingle();

    if (batch.error !== null) {
      return { status: "failed", retryable: true, reason: batch.error.message };
    }

    if (batch.data === null) {
      return { status: "failed", retryable: false, reason: `lote ${batchId} não existe` };
    }

    if (batch.data.status === "APPLIED") {
      // Reprocessar um lote já aplicado reescreveria a conferência que
      // sustentou a decisão humana.
      return { status: "failed", retryable: false, reason: "lote já aplicado" };
    }

    await deps.db.from("erp_import_batches").update({ status: "PARSING" }).eq("id", batchId);

    let sheet: readonly (readonly unknown[])[];

    try {
      sheet = await deps.reader.read(batch.data.storage_path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "falha ao ler o arquivo";

      await deps.db
        .from("erp_import_batches")
        .update({ status: "FAILED", last_error: reason })
        .eq("id", batchId);

      // Bucket indisponível é transitório; o lote volta a PARSING na próxima.
      return { status: "failed", retryable: true, reason };
    }

    const header = sheet[0] ?? [];
    const body = sheet.slice(1);

    const { rows, missing } = mapRows(batch.data.kind, header, body);

    if (missing.length > 0) {
      const reason = `colunas ausentes: ${missing.join(", ")}`;

      await deps.db
        .from("erp_import_batches")
        .update({ status: "FAILED", last_error: reason, total_rows: body.length })
        .eq("id", batchId);

      context.logger.error("erp_parse_wrong_file", { batch_id: batchId, missing });

      return { status: "failed", retryable: false, reason };
    }

    // Idempotência: o job pode ser reentregue. Limpar antes de inserir faz a
    // reexecução começar do zero em vez de colidir com a chave única.
    await deps.db.from("erp_import_rows").delete().eq("batch_id", batchId);
    await deps.db.from("erp_stock_snapshots").delete().eq("batch_id", batchId);

    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK);

      const inserted = await deps.db
        .from("erp_import_rows")
        .insert(chunk.map((row) => ({ ...row, batch_id: batchId })));

      if (inserted.error !== null) {
        return { status: "failed", retryable: true, reason: inserted.error.message };
      }
    }

    const counts = {
      total_rows: rows.length,
      ok_rows: rows.filter((r) => r.status === "OK").length,
      skipped_rows: rows.filter((r) => r.status === "SKIPPED").length,
      invalid_rows: rows.filter((r) => r.status === "INVALID").length,
    };

    await deps.db
      .from("erp_import_batches")
      .update({
        ...counts,
        status: "PARSED",
        parsed_at: (deps.now?.() ?? new Date()).toISOString(),
        last_error: null,
      })
      .eq("id", batchId);

    context.logger.info("erp_parse_finished", { batch_id: batchId, ...counts });

    return { status: "done", processed: counts.ok_rows };
  };
}
