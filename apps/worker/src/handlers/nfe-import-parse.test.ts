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
                      storage_path: "org/2026-08/hash.xml",
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
        read: () =>
          options.readFails === true
            ? Promise.reject(new Error("bucket fora do ar"))
            : Promise.resolve(options.xmlObject ?? fixtureXmlObject()),
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
    expect(lines.join()).toContain("nfe_parse_invalid_xml");
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
