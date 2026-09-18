import type { AdminClient } from "@sb/db";
import type { DocumentoLido, TipoDocumento } from "@sb/domain";
import { documentoDaNfe, lerDocumentoPdf, parseNfeXmlObject } from "@sb/domain";
import { z } from "zod";

import { lerLinhasDoPdf, lerPedacosDoPdf } from "../documentos/pdf-texto.js";
import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";

/**
 * Leitura do documento enviado. Segunda etapa do fluxo: `upload -> PARSE ->
 * conferência -> confirmação -> aplicação` (`docs/PROMPT_MASTER.md` secao
 * 13, mesmo formato de `erp-import-parse.ts`).
 *
 * Desde D-375 são quatro layouts: o XML da NF-e (o preferido), o DANFE em
 * PDF, o "Pedido de Saída" do UpSeller e as instruções de envio ao Full. O
 * XML continua no parser de sempre (`parseNfeXmlObject`, D-053); os PDFs
 * passam pelo extrator de texto (`documentos/pdf-texto.ts`) e pelos leitores
 * de layout (`@sb/domain/documentos`). Os quatro terminam na MESMA forma
 * (`DocumentoLido`) e são gravados por um caminho só.
 *
 * **O tipo sai do conteúdo, não do nome do arquivo.** O que a extensão decide
 * é apenas qual leitor abre o arquivo; quem diz "isto é um DANFE" é o título
 * impresso na página.
 *
 * Este handler **não gera `stock_movements`**. Ele só interpreta o arquivo e
 * grava `document_items` para a conferência. Todo item nasce SEM `sku_id`
 * — o vínculo é humano, na tela de conferência (`docs/NFE.md` secao 3),
 * não resolvido automaticamente aqui (diferente do UpSeller, que já tem
 * `sku_listing_links` confirmado para resolver contra).
 */

const payloadSchema = z.object({ documentId: z.uuid() });

/**
 * O arquivo do bucket, nas duas formas que este handler usa. Abstraído para o
 * teste não precisar de rede — implementação em `documento-reader.ts`.
 */
export interface DocumentoReader {
  /** O XML já convertido em objeto (a borda é a única que conhece `fast-xml-parser`). */
  lerXml: (storagePath: string) => Promise<unknown>;
  /** Os bytes crus — é assim que o PDF chega. */
  lerBytes: (storagePath: string) => Promise<Uint8Array>;
}

export interface NfeParseDeps {
  db: AdminClient;
  reader: DocumentoReader;
  now?: () => Date;
}

const CHUNK = 500;

/**
 * `documents.document_type` guarda o layout. `NFE_XML` virou só `NFE` na
 * coluna antes de D-375 existir, e renomear a coluna reescreveria histórico
 * por nada: a tradução mora aqui.
 */
const TIPO_NA_COLUNA: Record<TipoDocumento, string> = {
  NFE_XML: "NFE",
  DANFE_PDF: "DANFE_PDF",
  SAIDA_UPSELLER_PDF: "SAIDA_UPSELLER_PDF",
  ENVIO_FULL_ML_PDF: "ENVIO_FULL_ML_PDF",
};

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

    // CNPJ da própria organização decide ENTRADA/SAIDA (não `ide/tpNF`
    // sozinho — ver `packages/domain/src/nfe/parse.ts`; no DANFE é ele que
    // diz se somos o emitente). Sem ele, não há como interpretar o documento
    // com segurança: falha definitiva, não é algo que se resolve
    // reprocessando.
    const organization = await deps.db
      .from("organizations")
      .select("cnpj")
      .eq("id", document.data.organization_id)
      .maybeSingle();

    if (organization.error !== null) {
      return { status: "failed", retryable: true, reason: organization.error.message };
    }

    if (organization.data?.cnpj === null || organization.data?.cnpj === undefined) {
      const reason = "organização sem CNPJ cadastrado — não é possível decidir entrada/saída do documento";

      await deps.db.from("documents").update({ status: "FAILED", last_error: reason }).eq("id", documentId);

      return { status: "failed", retryable: false, reason };
    }

    const storagePath = document.data.storage_path;
    const ehPdf = storagePath.toLowerCase().endsWith(".pdf");

    await deps.db.from("documents").update({ status: "PARSING" }).eq("id", documentId);

    let arquivo: unknown;

    try {
      arquivo = ehPdf ? await deps.reader.lerBytes(storagePath) : await deps.reader.lerXml(storagePath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "falha ao ler o arquivo";

      await deps.db.from("documents").update({ status: "FAILED", last_error: reason }).eq("id", documentId);

      // Bucket indisponível é transitório; o documento volta a PARSING na próxima.
      return { status: "failed", retryable: true, reason };
    }

    const leitura = ehPdf
      ? lerPdf(arquivo as Uint8Array, organization.data.cnpj)
      : lerXml(arquivo, organization.data.cnpj);

    if (!leitura.ok) {
      await deps.db
        .from("documents")
        .update({ status: "FAILED", last_error: leitura.motivo })
        .eq("id", documentId);

      context.logger.error("documento_parse_invalido", {
        document_id: documentId,
        formato: ehPdf ? "PDF" : "XML",
        reason: leitura.motivo,
      });

      return { status: "failed", retryable: false, reason: leitura.motivo };
    }

    const documento = leitura.valor;

    // Idempotência: o job pode ser reentregue. Limpar antes de inserir faz a
    // reexecução começar do zero em vez de colidir com a chave única.
    await deps.db.from("document_items").delete().eq("document_id", documentId);

    /*
      `document_items.position` é ZERO-based desde o parser do XML (D-053), e é
      ela que a tela numera ("#1" = position 0) e que entra na chave de
      idempotência do movimento. Os leitores de PDF contam a partir de 1 porque
      é assim que o papel numera os itens — a conversão é aqui, num lugar só, em
      vez de cada leitor ter de conhecer a convenção da tabela.
    */
    const rows = documento.itens.map((item, indice) => ({
      document_id: documentId,
      position: indice,
      supplier_code: item.codigo,
      ean: item.ean,
      description: item.descricao,
      ncm: item.ncm,
      cfop: item.cfop,
      unit: item.unidade,
      quantity: item.quantidade,
      // Nulo, nunca zero: documento de separação não traz preço, e zero em
      // valor se leria como "de graça" (a distinção de D-254).
      unit_value: item.valorUnitario,
      total_value: item.valorTotal,
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
        document_type: TIPO_NA_COLUNA[documento.tipo],
        access_key: documento.chave,
        operation_type: documento.direcao,
        document_number: documento.numero,
        series: documento.serie,
        issue_date: documento.emitidoEm,
        issuer_cnpj: documento.emitenteCnpj,
        issuer_name: documento.emitenteNome,
        recipient_cnpj: leitura.destinatarioCnpj,
        recipient_name: leitura.destinatarioNome,
        reference: documento.referencia,
        total_items: rows.length,
        resolved_items: 0,
        parsed_at: (deps.now?.() ?? new Date()).toISOString(),
        last_error: null,
      })
      .eq("id", documentId);

    context.logger.info("documento_parse_finished", {
      document_id: documentId,
      tipo: documento.tipo,
      access_key: documento.chave,
      operation_type: documento.direcao,
      total_items: rows.length,
    });

    return { status: "done", processed: rows.length };
  };
}

/**
 * A leitura de um formato, na forma que o gravador espera. O destinatário sai
 * separado porque só o XML o traz: o DANFE imprime dois CNPJs sem dizer, em
 * texto, qual é qual, e o pedido de saída não tem emitente nenhum.
 */
type Leitura =
  | {
      readonly ok: true;
      readonly valor: DocumentoLido;
      readonly destinatarioCnpj: string | null;
      readonly destinatarioNome: string | null;
    }
  | { readonly ok: false; readonly motivo: string };

function lerXml(arquivo: unknown, cnpjProprio: string): Leitura {
  const resultado = parseNfeXmlObject(arquivo, cnpjProprio);

  if (!resultado.ok) return { ok: false, motivo: resultado.reason };

  return {
    ok: true,
    valor: documentoDaNfe(resultado.value),
    destinatarioCnpj: resultado.value.recipientCnpj,
    destinatarioNome: resultado.value.recipientName,
  };
}

function lerPdf(bytes: Uint8Array, cnpjProprio: string): Leitura {
  const leitura = lerDocumentoPdf(lerLinhasDoPdf(bytes), lerPedacosDoPdf(bytes), cnpjProprio);

  if (!leitura.ok) return { ok: false, motivo: leitura.motivo };

  return { ok: true, valor: leitura.valor, destinatarioCnpj: null, destinatarioNome: null };
}
