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
const DOCUMENT_VERSION = "2026-08-22T11:59:00.000Z";

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
  persistedVersions: string[];
}

function fakeDeps(options: {
  xmlObject?: unknown;
  status?: string;
  documentMissing?: boolean;
  readFails?: boolean;
  orgCnpj?: string | null;
  /** Bytes de um PDF; quando presente, o documento aponta para um `.pdf`. */
  pdf?: Uint8Array;
  /** O erro que o banco devolve a um `update`, decidido pelos valores gravados. */
  updateError?: (values: Record<string, unknown>) => { code: string; message: string } | null;
  persistenceError?: { code: string; message: string };
  /** Estado no banco depois de ler o documento, antes de tentar gravar PARSING. */
  beforeParsing?: () => { status: string; updatedAt: string };
  parsedAt?: string;
}): { deps: NfeParseDeps; captured: Captured; lines: string[] } {
  const captured: Captured = { updates: [], inserted: [], persistedVersions: [] };
  const lines: string[] = [];
  const orgCnpj = "orgCnpj" in options ? options.orgCnpj : OWN_CNPJ;
  let document = {
    id: DOCUMENT_ID,
    storage_path: options.pdf === undefined ? "org/2026-08/hash.xml" : "org/2026-09/hash.pdf",
    status: options.status ?? "UPLOADED",
    updated_at: DOCUMENT_VERSION,
    parsed_at: options.parsedAt ?? null,
    organization_id: ENVELOPE.organizationId,
  };

  function saveDocument(values: Record<string, unknown>) {
    captured.updates.push(values);
    document = {
      ...document,
      ...values,
      updated_at: new Date(Date.parse(DOCUMENT_VERSION) + captured.updates.length).toISOString(),
    };
  }

  const db = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => {
            if (table === "organizations") {
              return Promise.resolve({ data: { cnpj: orgCnpj }, error: null });
            }

            return Promise.resolve({
              data: options.documentMissing === true ? null : document,
              error: null,
            });
          },
        }),
      }),
      update: (values: Record<string, unknown>) => {
        const filters = new Map<string, unknown>();
        function execute() {
          const current = (values.status === "PARSING" ? options.beforeParsing?.() : undefined) ??
            { status: document.status, updatedAt: document.updated_at };
          const matches =
            (!filters.has("status") || filters.get("status") === current.status) &&
            (!filters.has("updated_at") || filters.get("updated_at") === current.updatedAt);
          const error = options.updateError?.(values) ?? null;
          if (!matches || error !== null) return Promise.resolve({ data: null, error });

          saveDocument(values);
          return Promise.resolve({ data: { id: DOCUMENT_ID, updated_at: document.updated_at }, error: null });
        }
        const update = {
          eq: (column: string, value: unknown) => {
            filters.set(column, value);
            return update;
          },
          select: () => ({ maybeSingle: execute }),
          then: (resolve: (result: Awaited<ReturnType<typeof execute>>) => void) => execute().then(resolve),
        };
        return update;
      },
    }),
    rpc: (_name: string, args: {
      p_parse_version: string;
      p_header: Record<string, unknown> | null;
      p_items: Record<string, unknown>[];
      p_parsed_at: string | null;
      p_error: string | null;
      p_error_code: string | null;
    }) => {
      if (document.status !== "PARSING" || document.updated_at !== args.p_parse_version) {
        return Promise.resolve({ data: false, error: null });
      }

      const values = {
        ...args.p_header,
        status: args.p_parsed_at === null ? "FAILED" : "PARSED",
        parsed_at: args.p_parsed_at,
        total_items: args.p_parsed_at === null ? null : args.p_items.length,
        resolved_items: args.p_parsed_at === null ? null : 0,
        last_error: args.p_error,
        last_error_code: args.p_error_code,
      };
      const error = options.persistenceError ?? options.updateError?.(values) ?? null;
      if (error !== null) return Promise.resolve({ data: null, error });

      saveDocument(values);
      if (args.p_items.length > 0) captured.inserted.push(args.p_items);
      captured.persistedVersions.push(args.p_parse_version);
      return Promise.resolve({ data: true, error: null });
    },
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
  it.each(["leitura válida", "erro de bucket"])("descarta %s de uma execução substituída em PARSING", async (result) => {
    const { deps, captured, lines } = fakeDeps({});
    const firstReading = Promise.withResolvers<undefined>();
    const finishFirst = Promise.withResolvers<unknown>();
    vi.spyOn(deps.reader, "lerXml").mockImplementationOnce(() => {
      firstReading.resolve(undefined);
      return finishFirst.promise;
    });
    const handle = createNfeImportParseHandler(deps);
    const first = handle(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));
    await firstReading.promise;

    let newer;
    try {
      newer = await handle({ ...ENVELOPE, attempt: 2 }, ctx(lines, { documentId: DOCUMENT_ID }));
    } finally {
      if (result === "erro de bucket") finishFirst.reject(new Error("bucket fora do ar"));
      else finishFirst.resolve(fixtureXmlObject());
    }
    const older = await first;

    expect(newer).toEqual({ status: "done", processed: 1 });
    expect(older).toMatchObject({ status: "failed", retryable: true });
    expect(captured.updates.at(-1)).toMatchObject({ status: "PARSED" });
    expect(captured.inserted).toHaveLength(1);
    expect(captured.persistedVersions).toHaveLength(1);
  });

  it.each(["PARSED", "APPLYING", "PARSING", "CANCELLED"])("não apaga itens se outra entrega avança para %s antes de PARSING", async (status) => {
    const { deps, captured, lines } = fakeDeps({
      status: status === "PARSING" ? "PARSING" : "UPLOADED",
      beforeParsing: () => ({ status, updatedAt: "2026-08-22T11:59:01.000Z" }),
    });
    const read = vi.spyOn(deps.reader, "lerXml");

    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(read).not.toHaveBeenCalled();
    expect(captured.updates).toEqual([]);
    expect(captured.persistedVersions).toEqual([]);
    expect(captured.inserted).toEqual([]);
  });

  it.each([
    { status: "PARSED" },
    { status: "FAILED", parsedAt: DOCUMENT_VERSION },
    { status: "CANCELLED" },
  ])("não reabre documento $status numa entrega tardia", async (fixture) => {
    const { deps, captured, lines } = fakeDeps(fixture);
    const read = vi.spyOn(deps.reader, "lerXml");

    await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(read).not.toHaveBeenCalled();
    expect(captured.updates).toEqual([]);
    expect(captured.persistedVersions).toEqual([]);
  });

  it("reprocessa PARSING quando a versão lida continua atual", async () => {
    const { deps, captured, lines } = fakeDeps({ status: "PARSING" });
    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(captured.updates.at(-1)).toMatchObject({ status: "PARSED" });
  });

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

  it("envia itens para persistência sem vínculo com SKU", async () => {
    const { deps, captured, lines } = fakeDeps({});

    await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(captured.inserted[0]).toEqual([
      {
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

  it("envia para a RPC a versão obtida na entrada em PARSING", async () => {
    const { deps, captured, lines } = fakeDeps({});

    await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(captured.persistedVersions).toEqual(["2026-08-22T11:59:00.001Z"]);
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

/**
 * D-497: a nota de venda feita pelo marketplace não mexe no estoque, e a leitura
 * que o banco não aceita vira FAILED com o erro dito, em vez de PARSING para
 * sempre.
 */
describe("parse: a venda de marketplace e a gravação recusada (D-497)", () => {
  const CONSUMIDOR = { CPF: "12345678909", xNome: "Comprador" };

  function notaDeVenda(intermediador: string | null, cfop = "5102"): unknown {
    const base = fixtureXmlObject({
      dest: CONSUMIDOR,
      det: [
        {
          "@_nItem": "1",
          prod: { cProd: "CAPACETE-1", cEAN: "SEM GTIN", xProd: "Capacete", CFOP: cfop, uCom: "UN", qCom: "1.0000", vUnCom: "200.00", vProd: "200.00" },
        },
      ],
    }) as { nfeProc: { NFe: { infNFe: Record<string, unknown> } } };
    const infNFe = base.nfeProc.NFe.infNFe;

    infNFe.emit = { CNPJ: OWN_CNPJ, xNome: "Speed Bikers Comercio LTDA" };

    if (intermediador !== null) {
      infNFe.ide = { ...(infNFe.ide as Record<string, unknown>), indIntermed: "1" };
      infNFe.infIntermed = { CNPJ: intermediador, idCadIntTran: "LOJA" };
    }

    return base;
  }

  it("recusa a nota de venda feita pelo Mercado Livre: FAILED com o código, sem itens, e não repete", async () => {
    const { deps, captured, lines } = fakeDeps({ xmlObject: notaDeVenda("03007331000141") });
    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(captured.inserted).toEqual([]);
    expect(captured.updates.at(-1)).toMatchObject({
      status: "FAILED",
      last_error_code: "SAIDA_VENDA_MARKETPLACE",
      operation_type: "SAIDA",
      intermediary_cnpj: "03007331000141",
      access_key: ACCESS_KEY,
    });
    expect(String(captured.updates.at(-1)?.last_error)).toContain("Mercado Livre");
    expect(lines.some((l) => l.includes("documento_recusado"))).toBe(true);
  });

  it("a nota de venda de balcão (sem intermediador) segue lida, e o código antigo é limpo", async () => {
    const { deps, captured, lines } = fakeDeps({ xmlObject: notaDeVenda(null) });
    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(captured.updates.at(-1)).toMatchObject({
      status: "PARSED",
      operation_type: "SAIDA",
      intermediary_cnpj: null,
      last_error: null,
      last_error_code: null,
    });
  });

  it("a recusa vale mesmo se o banco não aceitar o cabeçalho", async () => {
    const { deps, captured, lines } = fakeDeps({
      xmlObject: notaDeVenda("35635824000112"),
      updateError: (values) => ("access_key" in values ? { code: "23514", message: "violates check constraint" } : null),
    });
    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(captured.updates.at(-1)).toMatchObject({
      status: "FAILED",
      last_error: expect.stringContaining("Shopee") as string,
      last_error_code: "SAIDA_VENDA_MARKETPLACE",
    });
  });

  it("a gravação final recusada por dado vira FAILED com LEITURA_NAO_GRAVADA e não repete", async () => {
    const { deps, captured, lines } = fakeDeps({
      updateError: (values) =>
        values.status === "PARSED" ? { code: "23514", message: 'new row violates check constraint "documents_access_key_check"' } : null,
    });
    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(captured.updates.at(-1)).toEqual({
      status: "FAILED",
      last_error: expect.stringContaining("documents_access_key_check") as string,
      last_error_code: "LEITURA_NAO_GRAVADA",
    });
    expect(captured.persistedVersions).toEqual([]);
    expect(captured.inserted).toEqual([]);
  });

  it("erro passageiro na gravação final repete, sem marcar o documento", async () => {
    const { deps, captured, lines } = fakeDeps({
      updateError: (values) => (values.status === "PARSED" ? { code: "57014", message: "canceling statement due to statement timeout" } : null),
    });
    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(captured.updates.some((u) => u.last_error_code === "LEITURA_NAO_GRAVADA")).toBe(false);
  });

  it("D-746: documento em APPLYING não é reprocessado nem perde os itens vinculados", async () => {
    const { deps, captured, lines } = fakeDeps({ status: "APPLYING" });

    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(captured.persistedVersions).toEqual([]);
    expect(captured.updates).toEqual([]);
    expect(captured.inserted).toHaveLength(0);
  });

  it("falha transitória ao substituir itens retorna retryable sem confirmar a leitura", async () => {
    const { deps, captured, lines } = fakeDeps({
      persistenceError: { code: "57014", message: "delete timeout" },
    });

    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: true, reason: "delete timeout" });
    expect(captured.inserted).toHaveLength(0);
  });

  it("D-797: exceção inesperada do parser marca o documento como FAILED sem retry em vez de travá-lo em PARSING", async () => {
    const xmlCorrompido = {
      get nfeProc(): unknown {
        throw new RangeError("estrutura XML corrompida");
      },
    };
    const { deps, captured, lines } = fakeDeps({ xmlObject: xmlCorrompido });

    const outcome = await createNfeImportParseHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false, reason: "estrutura XML corrompida" });
    expect(captured.updates.at(-1)).toMatchObject({ status: "FAILED", last_error: "estrutura XML corrompida" });
    expect(lines.join("\n")).toContain("documento_parse_invalido");
  });
});
