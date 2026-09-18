import { deflateSync } from "node:zlib";

import { createLogger } from "@sb/observability";
import { describe, expect, it, vi } from "vitest";

import type { NfeParseDeps } from "./nfe-import-parse.js";
import { createNfeImportParseHandler } from "./nfe-import-parse.js";

const DOCUMENT_ID = "d1000000-0000-4000-8000-00000000000d";
const OWN_CNPJ = "98765432000110"; // CNPJ da organização — mesmo valor usado como dest/CNPJ no fixture padrão.

const ENVELOPE = {
  jobType: "nfe.import.parse",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
  organizationId: "11111111-0000-4000-8000-000000000001",
  dedupeKey: `nfe-parse:${DOCUMENT_ID}`,
  attempt: 1,
  enqueuedAt: "2026-08-22T12:00:00.000Z",
};

const ACCESS_KEY = "35260812345678000190550010000012345123456789";

function fixtureXmlObject(overrides: { det?: unknown[]; dest?: unknown } = {}): unknown {
  return {
    nfeProc: {
      NFe: {
        infNFe: {
          "@_Id": `NFe${ACCESS_KEY}`,
          ide: { nNF: "12345", serie: "1", dhEmi: "2026-08-20T10:00:00-03:00", tpNF: "1" },
          emit: { CNPJ: "12345678000190", xNome: "Fornecedor Exemplo LTDA" },
          dest: overrides.dest ?? { CNPJ: OWN_CNPJ, xNome: "Speed Bikers Comercio LTDA" },
          det: overrides.det ?? [
            {
              "@_nItem": "1",
              prod: {
                cProd: "PARAFUSO-001",
                cEAN: "7891234567890",
                xProd: "Parafuso M6",
                uCom: "UN",
                qCom: "100.0000",
                vUnCom: "0.5000",
                vProd: "50.0000",
              },
            },
          ],
        },
      },
    },
  };
}

interface Captured {
  updates: Record<string, unknown>[];
  inserted: Record<string, unknown>[][];
  deletedTables: string[];
}

function fakeDeps(options: {
  xmlObject?: unknown;
  status?: string;
  documentMissing?: boolean;
  readFails?: boolean;
  orgCnpj?: string | null;
  /** Bytes de um PDF; quando presente, o documento aponta para um `.pdf`. */
  pdf?: Uint8Array;
}): { deps: NfeParseDeps; captured: Captured; lines: string[] } {
  const captured: Captured = { updates: [], inserted: [], deletedTables: [] };
  const lines: string[] = [];
  const orgCnpj = "orgCnpj" in options ? options.orgCnpj : OWN_CNPJ;

  const db = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => {
            if (table === "organizations") {
              return Promise.resolve({ data: { cnpj: orgCnpj }, error: null });
            }

            return Promise.resolve({
              data:
                options.documentMissing === true
                  ? null
                  : {
                      id: DOCUMENT_ID,
                      storage_path: options.pdf === undefined ? "org/2026-08/hash.xml" : "org/2026-09/hash.pdf",
                      status: options.status ?? "UPLOADED",
                      organization_id: ENVELOPE.organizationId,
                    },
              error: null,
            });
          },
        }),
      }),
      update: (values: Record<string, unknown>) => {
        captured.updates.push(values);

        return { eq: () => Promise.resolve({ error: null }) };
      },
      insert: (rows: Record<string, unknown>[]) => {
        captured.inserted.push(rows);

        return Promise.resolve({ error: null });
      },
      delete: () => {
        captured.deletedTables.push(table);

        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  } as unknown as NfeParseDeps["db"];

  return {
    captured,
    lines,
    deps: {
      db,
      now: () => new Date("2026-08-22T12:00:00.000Z"),
      reader: {
        lerXml: () =>
          options.readFails === true
            ? Promise.reject(new Error("bucket fora do ar"))
            : Promise.resolve(options.xmlObject ?? fixtureXmlObject()),
        lerBytes: () =>
          options.pdf === undefined
            ? Promise.reject(new Error("este documento não é PDF"))
            : Promise.resolve(options.pdf),
      },
    },
  };
}

function ctx(lines: string[], payload: unknown): { logger: ReturnType<typeof createLogger>; payload: unknown } {
  return { logger: createLogger({}, { sink: (line) => lines.push(line) }), payload };
}

describe("parse do XML da NF-e", () => {
  it("extrai os campos do documento e marca como PARSED", async () => {
    const { deps, captured, lines } = fakeDeps({});

    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(captured.updates.at(-1)).toMatchObject({
      status: "PARSED",
      access_key: ACCESS_KEY,
      operation_type: "ENTRADA",
      document_number: "12345",
      series: "1",
      issuer_cnpj: "12345678000190",
      issuer_name: "Fornecedor Exemplo LTDA",
      recipient_cnpj: OWN_CNPJ,
      recipient_name: "Speed Bikers Comercio LTDA",
      total_items: 1,
      resolved_items: 0,
    });
  });

  it("grava document_items com sku_id nulo — vínculo é humano, não automático", async () => {
    const { deps, captured, lines } = fakeDeps({});

    await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(captured.inserted[0]).toEqual([
      {
        document_id: DOCUMENT_ID,
        position: 0,
        supplier_code: "PARAFUSO-001",
        ean: "7891234567890",
        description: "Parafuso M6",
        ncm: null,
        cfop: null,
        unit: "UN",
        quantity: 100,
        unit_value: 0.5,
        total_value: 50,
        sku_id: null,
      },
    ]);
  });

  it("organização sem CNPJ cadastrado: falha definitiva antes de ler o arquivo", async () => {
    const { deps, captured, lines } = fakeDeps({ orgCnpj: null });

    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect("reason" in outcome ? outcome.reason : "").toContain("CNPJ");
    expect(captured.inserted).toHaveLength(0);
  });

  it("achado real: fornecedor emite com tpNF=1 (saída dele) e Speed Bikers como dest — vira ENTRADA no nosso estoque", async () => {
    const { deps, captured, lines } = fakeDeps({});

    await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(captured.updates.at(-1)).toMatchObject({ operation_type: "ENTRADA" });
  });

  it("Speed Bikers como emitente: SAIDA, mesmo com tpNF=1", async () => {
    const { deps, captured, lines } = fakeDeps({
      xmlObject: {
        nfeProc: {
          NFe: {
            infNFe: {
              "@_Id": `NFe${ACCESS_KEY}`,
              ide: { nNF: "12345", serie: "1", dhEmi: "2026-08-20T10:00:00-03:00", tpNF: "1" },
              emit: { CNPJ: OWN_CNPJ, xNome: "Speed Bikers Comercio LTDA" },
              dest: { CNPJ: "12345678000190", xNome: "Cliente Qualquer" },
              det: [
                {
                  "@_nItem": "1",
                  prod: {
                    cProd: "X",
                    cEAN: "1",
                    xProd: "Item",
                    uCom: "UN",
                    qCom: "1",
                    vUnCom: "10",
                    vProd: "10",
                  },
                },
              ],
            },
          },
        },
      },
    });

    await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(captured.updates.at(-1)).toMatchObject({ operation_type: "SAIDA" });
  });

  it("múltiplos itens: total_items reflete a quantidade", async () => {
    const { deps, captured, lines } = fakeDeps({
      xmlObject: fixtureXmlObject({
        det: [
          { "@_nItem": "1", prod: { cProd: "A", cEAN: "1", xProd: "Item A", uCom: "UN", qCom: "1", vUnCom: "10", vProd: "10" } },
          { "@_nItem": "2", prod: { cProd: "B", cEAN: "2", xProd: "Item B", uCom: "UN", qCom: "2", vUnCom: "5", vProd: "10" } },
        ],
      }),
    });

    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toEqual({ status: "done", processed: 2 });
    expect(captured.updates.at(-1)).toMatchObject({ total_items: 2 });
  });

  it("limpa document_items antes de inserir — reexecução não colide com a chave única", async () => {
    const { deps, captured, lines } = fakeDeps({});

    await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(captured.deletedTables).toContain("document_items");
  });

  it("XML fora do layout NF-e: falha definitiva, sem inserir nada", async () => {
    const { deps, captured, lines } = fakeDeps({ xmlObject: { algumaCoisa: true } });

    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(captured.updates.at(-1)).toMatchObject({ status: "FAILED" });
    expect(captured.inserted).toHaveLength(0);
    expect(lines.join()).toContain("documento_parse_invalido");
  });

  it("payload sem documentId é falha DEFINITIVA — repetir não resolve", async () => {
    const { deps, lines } = fakeDeps({});

    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { nada: true }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });

  it("documento inexistente é falha definitiva", async () => {
    const { deps, lines } = fakeDeps({ documentMissing: true });

    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });

  it("documento já APLICADO não é reprocessado", async () => {
    const { deps, captured, lines } = fakeDeps({ status: "APPLIED" });

    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(captured.inserted).toHaveLength(0);
  });

  it("bucket indisponível é falha TRANSITÓRIA — a fila repete", async () => {
    const { deps, captured, lines } = fakeDeps({ readFails: true });

    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(captured.updates.at(-1)).toMatchObject({ status: "FAILED" });
  });

  it("não toca em skus, stock_movements nem inventory_balances — parse só escreve staging", async () => {
    const { deps, lines } = fakeDeps({});
    const spy = vi.spyOn(deps.db, "from");

    await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    const tables = spy.mock.calls.map((c) => c[0]);

    expect(tables).not.toContain("skus");
    expect(tables).not.toContain("stock_movements");
    expect(tables).not.toContain("inventory_balances");
  });
});

/**
 * Um PDF de "Pedido de Saída" montado aqui — o arquivo real não entra no
 * repositório (`docs/NFE.md`). O que este bloco garante é o CAMINHO: `.pdf` usa
 * o leitor de bytes, o layout é reconhecido pelo conteúdo e o documento nasce
 * como saída, sem valor nenhum inventado.
 */
function pdfDoPedidoDeSaida(): Uint8Array {
  const escrever = (x: number, y: number, texto: string): string =>
    `BT 1 0 0 1 ${String(x)} ${String(y)} Tm (${texto}) Tj ET\n`;

  const conteudo = [
    escrever(30, 800, "Pedido de Saida"),
    escrever(30, 780, "No da Saida: OUT12467"),
    escrever(30, 760, "Armazem: ESTOQUE LOJA"),
    escrever(30, 740, "Observacao"),
    escrever(30, 720, "ENVIO FULL #77375684 CONTA 1"),
    // O cabecalho da tabela: e ele que da o x de cada coluna.
    escrever(30, 700, "#"),
    escrever(79, 700, "SKU"),
    escrever(400, 700, "Estante"),
    escrever(740, 700, "Qtd."),
    escrever(30, 680, "1"),
    escrever(131, 680, "BAU05"),
    escrever(720, 680, "x 20"),
    escrever(131, 660, "Bau Traseiro Plastico 45L"),
  ].join("");

  return new Uint8Array(
    Buffer.concat([
      Buffer.from("%PDF-1.7\n1 0 obj\n<< /Length 0 >>\nstream\n", "latin1"),
      deflateSync(Buffer.from(conteudo, "latin1")),
      Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
    ]),
  );
}

describe("parse de PDF (D-375)", () => {
  it("pedido de saída do UpSeller: vira documento de SAÍDA, sem valor inventado", async () => {
    const { deps, captured, lines } = fakeDeps({ pdf: pdfDoPedidoDeSaida() });

    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(captured.updates.at(-1)).toMatchObject({
      status: "PARSED",
      document_type: "SAIDA_UPSELLER_PDF",
      operation_type: "SAIDA",
      document_number: "OUT12467",
      reference: "Armazém ESTOQUE LOJA · ENVIO FULL #77375684 CONTA 1",
      // Pedido de saída não é documento fiscal: nada de chave nem de emitente.
      access_key: null,
      issuer_cnpj: null,
      total_items: 1,
    });
    expect(captured.inserted[0]).toEqual([
      {
        document_id: DOCUMENT_ID,
        // Zero-based como no XML: é a numeração que a tela e a chave de
        // idempotência já usam, e o leitor conta a partir de 1 (D-375).
        position: 0,
        supplier_code: "BAU05",
        ean: null,
        description: "Bau Traseiro Plastico 45L",
        ncm: null,
        cfop: null,
        unit: null,
        quantity: 20,
        // Nulo, não zero: zero se leria como "de graça" (D-254).
        unit_value: null,
        total_value: null,
        sku_id: null,
      },
    ]);
  });

  it("PDF que nenhum leitor reconhece: falha DEFINITIVA com o motivo que a tela mostra", async () => {
    const { deps, captured, lines } = fakeDeps({ pdf: new Uint8Array(Buffer.from("%PDF-1.7 sem texto algum", "latin1")) });

    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(String(captured.updates.at(-1)?.last_error)).toContain("não foi possível ler texto neste PDF");
  });
});
