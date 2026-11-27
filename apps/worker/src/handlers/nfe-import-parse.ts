import type { AdminClient, TablesInsert, TablesUpdate } from "@sb/db";
import type { DocumentoLido, TipoDocumento } from "@sb/domain";
import { digitos, documentoDaNfe, lerDocumentoPdf, parseNfeXmlObject, recusaDeVendaDeMarketplace } from "@sb/domain";
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

interface NfeParseRpc {
  rpc(
    name: "persist_nfe_parse",
    args: {
      p_document_id: string;
      p_parse_version: string;
      p_header: TablesUpdate<"documents"> | null;
      p_items: Omit<TablesInsert<"document_items">, "document_id" | "sku_id">[];
      p_parsed_at: string | null;
      p_error: string | null;
      p_error_code: string | null;
    },
  ): PromiseLike<{ data: boolean | null; error: { code: string; message: string } | null }>;
}

const PARSE_SUPERADO = { status: "failed", retryable: true, reason: "a versão da leitura foi substituída" } as const;

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

/**
 * Erro de DADO do Postgres (classes 22, dado inválido, e 23, restrição
 * violada): repetir dá o mesmo erro. O documento vira FAILED com o erro dito, em
 * vez de ficar em PARSING para sempre quando as tentativas acabam (D-497 -- um
 * DANFE de 18/09 ficou assim, com a gravação final recusada e o erro engolido).
 */
function erroDeDado(error: { code?: string } | null): boolean {
  return error?.code !== undefined && /^2[23]/.test(error.code);
}

export function createNfeImportParseHandler(deps: NfeParseDeps): JobHandler {
  // Contrato local da migration até regenerar os tipos compartilhados a partir do Dev.
  const persistence = deps.db as unknown as NfeParseRpc;

  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem documentId" };
    }

    const { documentId } = parsed.data;

    const document = await deps.db
      .from("documents")
      .select("id, status, organization_id, storage_path, updated_at, parsed_at")
      .eq("id", documentId)
      .maybeSingle();

    if (document.error !== null) {
      return { status: "failed", retryable: true, reason: document.error.message };
    }

    if (document.data === null) {
      return { status: "failed", retryable: false, reason: `documento ${documentId} não existe` };
    }

    if (document.data.organization_id !== envelope.organizationId) {
      return { status: "failed", retryable: false, reason: "documento não pertence à organização do job" };
    }

    if (document.data.status === "APPLIED" || document.data.status === "APPLYING") {
      // Reprocessar um documento em aplicação ou já aplicado apagaria os itens
      // já vinculados e reescreveria a conferência humana (D-746).
      return {
        status: "failed",
        retryable: false,
        reason: document.data.status === "APPLIED" ? "documento já aplicado" : "documento já em aplicação",
      };
    }

    if (document.data.status === "PARSED" || document.data.status === "CANCELLED" || document.data.parsed_at !== null) {
      // A API só reenvia documentos que falharam antes de concluir a leitura.
      return { status: "done", processed: 0 };
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

    // A leitura acima pode ter ficado antiga enquanto buscávamos o CNPJ.
    // A comparação de versão também detecta PARSING -> PARSING numa reentrega.
    const parsing = await deps.db
      .from("documents")
      .update({ status: "PARSING" })
      .eq("id", documentId)
      .eq("status", document.data.status)
      .eq("updated_at", document.data.updated_at)
      .select("updated_at")
      .maybeSingle();

    if (parsing.error !== null) {
      return { status: "failed", retryable: true, reason: parsing.error.message };
    }

    if (parsing.data === null) {
      return { status: "failed", retryable: true, reason: "documento mudou antes de iniciar a leitura" };
    }

    const version = parsing.data.updated_at;

    if (organization.data?.cnpj === null || organization.data?.cnpj === undefined) {
      const reason = "organização sem CNPJ cadastrado — não é possível decidir entrada/saída do documento";

      return marcarFalhaDeLeitura(deps.db, documentId, version, reason, false);
    }

    const storagePath = document.data.storage_path;
    const ehPdf = storagePath.toLowerCase().endsWith(".pdf");

    let arquivo: unknown;

    try {
      arquivo = ehPdf ? await deps.reader.lerBytes(storagePath) : await deps.reader.lerXml(storagePath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "falha ao ler o arquivo";

      // Bucket indisponível é transitório; o documento volta a PARSING na próxima.
      return marcarFalhaDeLeitura(deps.db, documentId, version, reason, true);
    }

    let leitura: Leitura;

    try {
      leitura = ehPdf
        ? lerPdf(arquivo as Uint8Array, organization.data.cnpj)
        : lerXml(arquivo, organization.data.cnpj);
    } catch (error) {
      leitura = {
        ok: false,
        motivo: error instanceof Error ? error.message : "falha ao interpretar o documento",
      };
    }

    if (!leitura.ok) {
      context.logger.error("documento_parse_invalido", {
        document_id: documentId,
        formato: ehPdf ? "PDF" : "XML",
        reason: leitura.motivo,
      });

      return marcarFalhaDeLeitura(deps.db, documentId, version, leitura.motivo, false);
    }

    const documento = leitura.valor;
    const intermediario = digitos(documento.intermediadorCnpj);

    // O cabeçalho que a leitura conhece -- gravado também na recusa, para a tela
    // dizer QUAL nota foi recusada.
    const cabecalho = {
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
      intermediary_cnpj: intermediario.length === 14 ? intermediario : null,
    };

    /*
      D-497: a nota de venda (ou de devolução de venda) feita pelo Mercado Livre
      ou pela Shopee não mexe no estoque -- a baixa do pedido já cobre. Recusada
      na leitura, sem itens para conferir; a api e a aplicação repetem a guarda.
    */
    const recusa = recusaDeVendaDeMarketplace({
      tipo: documento.tipo,
      direcao: documento.direcao,
      intermediadorCnpj: documento.intermediadorCnpj,
      cfops: documento.itens.map((item) => item.cfop),
    });

    /*
      `document_items.position` é ZERO-based desde o parser do XML (D-053), e é
      ela que a tela numera ("#1" = position 0) e que entra na chave de
      idempotência do movimento. Os leitores de PDF contam a partir de 1 porque
      é assim que o papel numera os itens — a conversão é aqui, num lugar só, em
      vez de cada leitor ter de conhecer a convenção da tabela.
    */
    const itens = (recusa === null ? documento.itens : []).map((item, indice) => ({
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
    }));

    const resultado = {
      p_document_id: documentId,
      p_parse_version: version,
      p_header: cabecalho,
      p_items: itens,
      p_parsed_at: recusa === null ? (deps.now?.() ?? new Date()).toISOString() : null,
      p_error: recusa?.motivo ?? null,
      p_error_code: recusa?.codigo ?? null,
    };
    let gravado = await persistence.rpc("persist_nfe_parse", resultado);

    if (recusa !== null && erroDeDado(gravado.error)) {
      gravado = await persistence.rpc("persist_nfe_parse", { ...resultado, p_header: null });
    }

    if (gravado.error !== null) {
      if (erroDeDado(gravado.error)) {
        const reason = `a leitura não pôde ser gravada: ${gravado.error.message}`;
        return marcarFalhaDeLeitura(deps.db, documentId, version, reason, false, "LEITURA_NAO_GRAVADA");
      }

      return { status: "failed", retryable: true, reason: gravado.error.message };
    }

    if (gravado.data !== true) {
      return PARSE_SUPERADO;
    }

    if (recusa !== null) {
      context.logger.warn("documento_recusado", {
        document_id: documentId,
        tipo: documento.tipo,
        codigo: recusa.codigo,
        intermediary_cnpj: cabecalho.intermediary_cnpj,
      });

      return { status: "done", processed: 0 };
    }

    context.logger.info("documento_parse_finished", {
      document_id: documentId,
      tipo: documento.tipo,
      access_key: documento.chave,
      operation_type: documento.direcao,
      total_items: itens.length,
    });

    return { status: "done", processed: itens.length };
  };
}

async function marcarFalhaDeLeitura(
  db: AdminClient,
  documentId: string,
  version: string,
  reason: string,
  retryable: boolean,
  code?: "LEITURA_NAO_GRAVADA",
): Promise<JobOutcome> {
  const failed = await db
    .from("documents")
    .update({ status: "FAILED", last_error: reason, last_error_code: code ?? null })
    .eq("id", documentId)
    .eq("status", "PARSING")
    .eq("updated_at", version)
    .select("id")
    .maybeSingle();

  if (failed.error !== null) {
    return { status: "failed", retryable: true, reason: failed.error.message };
  }

  return failed.data === null ? PARSE_SUPERADO : { status: "failed", retryable, reason };
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
