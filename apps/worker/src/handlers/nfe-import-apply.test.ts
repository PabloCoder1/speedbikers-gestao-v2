import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { NfeApplyDeps } from "./nfe-import-apply.js";
import { createNfeImportApplyHandler } from "./nfe-import-apply.js";

const DOCUMENT_ID = "d1000000-0000-4000-8000-00000000000d";
const ORG_ID = "11111111-0000-4000-8000-000000000001";

const ENVELOPE = {
  jobType: "nfe.import.apply",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
  organizationId: ORG_ID,
  dedupeKey: `nfe-apply:${DOCUMENT_ID}`,
  attempt: 1,
  enqueuedAt: "2026-08-22T12:00:00.000Z",
};

interface Captured {
  documentUpdates: Record<string, unknown>[];
  movements: Record<string, unknown>[];
}

function fakeDeps(options: {
  status?: string;
  operationType?: string | null;
  issueDate?: string | null;
  totalItems?: number | null;
  resolvedItems?: number | null;
  documentMissing?: boolean;
  items?: { position: number; sku_id: string | null; quantity: number }[];
  movementInsertFails?: boolean;
}): { deps: NfeApplyDeps; captured: Captured; lines: string[] } {
  const captured: Captured = { documentUpdates: [], movements: [] };
  const lines: string[] = [];

  const items =
    options.items ?? [
      { position: 0, sku_id: "sku-parafuso", quantity: 19 },
    ];

  const db = {
    from: (table: string) => {
      if (table === "documents") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data:
                    options.documentMissing === true
                      ? null
                      : {
                          id: DOCUMENT_ID,
                          status: options.status ?? "APPLYING",
                          organization_id: ORG_ID,
                          operation_type: "operationType" in options ? options.operationType : "ENTRADA",
                          issue_date: "issueDate" in options ? options.issueDate : "2026-08-20T10:00:00.000Z",
                          total_items: "totalItems" in options ? options.totalItems : items.length,
                          resolved_items: "resolvedItems" in options ? options.resolvedItems : items.length,
                        },
                  error: null,
                }),
            }),
          }),
          update: (values: Record<string, unknown>) => {
            captured.documentUpdates.push(values);

            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }

      if (table === "document_items") {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: items, error: null }),
            }),
          }),
        };
      }

      if (table === "stock_movements") {
        return {
          insert: (row: Record<string, unknown>) => {
            captured.movements.push(row);

            return Promise.resolve(
              options.movementInsertFails === true ? { error: { message: "boom", code: "23503" } } : { error: null },
            );
          },
          // upsert espelha insert: domain_events/stock_movements passaram a
          // gravar por ON CONFLICT DO NOTHING (D-092).
          upsert: (row: Record<string, unknown>) => {
            captured.movements.push(row);

            return Promise.resolve(
              options.movementInsertFails === true ? { error: { message: "boom", code: "23503" } } : { error: null },
            );
          },
        };
      }

      throw new Error(`tabela inesperada no fake: ${table}`);
    },
  } as unknown as NfeApplyDeps["db"];

  return {
    captured,
    lines,
    deps: {
      db,
      now: () => new Date("2026-08-22T12:00:00.000Z"),
    },
  };
}

function ctx(lines: string[], payload: unknown): { logger: ReturnType<typeof createLogger>; payload: unknown } {
  return { logger: createLogger({}, { sink: (line) => lines.push(line) }), payload };
}

describe("aplicação da NF-e conferida", () => {
  it("ENTRADA gera stock_movements com qty positivo e marca o documento como APPLIED", async () => {
    const { deps, captured, lines } = fakeDeps({});

    const outcome = await createNfeImportApplyHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(captured.movements).toEqual([
      expect.objectContaining({
        organization_id: ORG_ID,
        sku_id: "sku-parafuso",
        location_kind: "LOCAL",
        qty_delta: 19,
        movement_type: "ENTRADA_NFE",
        source_type: "DOCUMENT",
        source_id: DOCUMENT_ID,
        idempotency_key: `nfe:${DOCUMENT_ID}:0`,
      }),
    ]);
    expect(captured.documentUpdates.at(-1)).toMatchObject({ status: "APPLIED" });
  });

  // D-187 — o ganho concreto de promover a escrita de movimento a crítica.
  //
  // A opção `movementInsertFails` existia neste fake e **nenhum teste a
  // usava**: o caminho de falha nunca foi exercitado. Até D-186 ele produzia
  // o pior desfecho possível — os movimentos não entravam, o
  // `documents.update({status:"APPLIED"})` logo abaixo rodava assim mesmo, e
  // a nota nunca mais era reprocessada. Estoque perdido em definitivo, sem
  // nenhum sinal: `verify-ledger-integrity` compara a soma do ledger contra a
  // projeção do trigger, e a linha ausente falta dos dois lados.
  it("falha ao gravar movimentos NÃO marca a nota como aplicada (D-187)", async () => {
    const { deps, captured, lines } = fakeDeps({ movementInsertFails: true });

    await expect(createNfeImportApplyHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }))).rejects.toThrow(
      /stock_movements.*ENTRADA_NFE/,
    );

    // O ponto do teste: sem os movimentos, a nota continua reprocessável.
    expect(captured.documentUpdates.filter((update) => update.status === "APPLIED")).toEqual([]);
  });

  it("SAIDA gera stock_movements com qty negativo", async () => {
    const { deps, captured, lines } = fakeDeps({ operationType: "SAIDA" });

    await createNfeImportApplyHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(captured.movements[0]).toMatchObject({ qty_delta: -19, movement_type: "SAIDA_NFE" });
  });

  it("item sem vínculo não gera movimento", async () => {
    const { deps, captured, lines } = fakeDeps({
      items: [
        { position: 0, sku_id: "sku-parafuso", quantity: 19 },
        { position: 1, sku_id: null, quantity: 3 },
      ],
      totalItems: 2,
      resolvedItems: 1,
    });

    const outcome = await createNfeImportApplyHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    // resolved (1) < total (2): a checagem de completude barra antes de gerar qualquer movimento.
    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(captured.movements).toHaveLength(0);
  });

  it("documento já APLICADO não é reprocessado", async () => {
    const { deps, captured, lines } = fakeDeps({ status: "APPLIED" });

    const outcome = await createNfeImportApplyHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(captured.movements).toHaveLength(0);
  });

  it("documento fora de APPLYING é recusado — só a confirmação humana libera este job", async () => {
    const { deps, captured, lines } = fakeDeps({ status: "PARSED" });

    const outcome = await createNfeImportApplyHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(captured.movements).toHaveLength(0);
  });

  it("documento inexistente é falha definitiva", async () => {
    const { deps, lines } = fakeDeps({ documentMissing: true });

    const outcome = await createNfeImportApplyHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });

  it("checagem de completude repetida aqui: resolved < total nunca deveria ter chegado, mas falha definitivo se chegar", async () => {
    const { deps, captured, lines } = fakeDeps({ totalItems: 3, resolvedItems: 2 });

    const outcome = await createNfeImportApplyHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(captured.movements).toHaveLength(0);
  });

  it("payload sem documentId é falha definitiva", async () => {
    const { deps, lines } = fakeDeps({});

    const outcome = await createNfeImportApplyHandler(deps)(ENVELOPE, ctx(lines, { nada: true }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });

  it("chave de idempotência inclui o documento e a posição — reprocessar não duplicaria o ledger", async () => {
    const { deps, captured, lines } = fakeDeps({
      items: [
        { position: 0, sku_id: "sku-a", quantity: 1 },
        { position: 1, sku_id: "sku-b", quantity: 2 },
      ],
      totalItems: 2,
      resolvedItems: 2,
    });

    await createNfeImportApplyHandler(deps)(ENVELOPE, ctx(lines, { documentId: DOCUMENT_ID }));

    expect(captured.movements.map((m) => m.idempotency_key)).toEqual([
      `nfe:${DOCUMENT_ID}:0`,
      `nfe:${DOCUMENT_ID}:1`,
    ]);
  });
});
