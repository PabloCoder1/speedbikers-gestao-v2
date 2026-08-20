import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { ApplyDeps } from "./erp-import-apply.js";
import { createErpImportApplyHandler } from "./erp-import-apply.js";

const ORG = "11111111-0000-4000-8000-000000000001";
const BATCH = "b1000000-0000-4000-8000-00000000000b";

const ENVELOPE = {
  jobType: "erp.import.apply",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b11",
  organizationId: ORG,
  dedupeKey: `erp-apply:${BATCH}`,
  attempt: 1,
  enqueuedAt: "2026-08-20T12:00:00.000Z",
};

/**
 * Banco falso mínimo, genérico o suficiente para as cadeias que o handler usa
 * em seis tabelas diferentes: `select().eq().in()`, `select().eq().maybeSingle()`,
 * `insert().select()`, `update().eq()`, `update().eq().in()` e `upsert(..., opts)`.
 *
 * Testar contra Postgres real é papel de `@sb/db` (RLS, constraints); aqui o
 * que está sob teste é a DECISÃO — inserir, atualizar ou preservar.
 */
type FakeRow = Record<string, unknown>;

function createFakeDb(seed: Record<string, FakeRow[]> = {}): {
  db: ApplyDeps["db"];
  tables: Record<string, FakeRow[]>;
} {
  const tables: Record<string, FakeRow[]> = seed;
  let counter = 0;

  function nextId(prefix: string): string {
    counter += 1;

    return `${prefix}-${String(counter)}`;
  }

  function ensure(table: string): FakeRow[] {
    tables[table] ??= [];

    return tables[table];
  }

  interface Filter {
    col: string;
    op: "eq" | "in";
    value: unknown;
  }

  function applyFilters(rows: FakeRow[], filters: Filter[]): FakeRow[] {
    return rows.filter((row) =>
      filters.every((f) =>
        f.op === "eq" ? row[f.col] === f.value : Array.isArray(f.value) && f.value.includes(row[f.col]),
      ),
    );
  }

  function project(rows: FakeRow[], cols: string | undefined): FakeRow[] {
    if (cols === undefined) return rows;

    const names = cols.split(",").map((c) => c.trim());

    return rows.map((row) => Object.fromEntries(names.map((name) => [name, row[name] ?? null])));
  }

  function builder(table: string): unknown {
    const filters: Filter[] = [];
    let cols: string | undefined;
    let rangeFrom = 0;
    let rangeTo = Number.POSITIVE_INFINITY;

    function currentSelection(): FakeRow[] {
      const filtered = applyFilters(ensure(table), filters);

      return filtered.slice(rangeFrom, rangeTo + 1);
    }

    const api = {
      select(selected: string) {
        cols = selected;

        return api;
      },
      eq(col: string, value: unknown) {
        filters.push({ col, op: "eq", value });

        return api;
      },
      in(col: string, value: unknown[]) {
        filters.push({ col, op: "in", value });

        return api;
      },
      order() {
        return api;
      },
      range(from: number, to: number) {
        rangeFrom = from;
        rangeTo = to;

        return api;
      },
      maybeSingle() {
        const rows = currentSelection();

        return Promise.resolve({ data: project(rows, cols)[0] ?? null, error: null });
      },
      insert(payload: FakeRow | FakeRow[]) {
        const items = (Array.isArray(payload) ? payload : [payload]).map((item) => ({
          id: nextId(table),
          created_at: "2026-08-20T12:00:00.000Z",
          updated_at: "2026-08-20T12:00:00.000Z",
          sku_key: typeof item.sku === "string" ? item.sku.trim().toUpperCase() : undefined,
          ...item,
        }));

        ensure(table).push(...items);

        const resolved = Promise.resolve({ data: project(items, cols), error: null });

        return { select: (selected: string) => { cols = selected; return Promise.resolve({ data: project(items, selected), error: null }); }, then: resolved.then.bind(resolved) };
      },
      update(values: FakeRow) {
        return {
          eq(col: string, value: unknown) {
            filters.push({ col, op: "eq", value });

            const chain = {
              eq(col2: string, value2: unknown) {
                filters.push({ col: col2, op: "eq", value: value2 });

                return chain;
              },
              in(col2: string, value2: unknown[]) {
                filters.push({ col: col2, op: "in", value: value2 });

                return chain;
              },
              then(resolve: (v: { error: null }) => void) {
                for (const row of currentSelection()) Object.assign(row, values);
                resolve({ error: null });
              },
            };

            return chain;
          },
        };
      },
      upsert(payload: FakeRow[], opts: { onConflict: string }) {
        const keys = opts.onConflict.split(",");
        const target = ensure(table);

        for (const item of payload) {
          const match = target.find((row) => keys.every((k) => row[k] === item[k]));

          if (match !== undefined) {
            Object.assign(match, item);
          } else {
            target.push({ id: nextId(table), created_at: "2026-08-20T12:00:00.000Z", ...item });
          }
        }

        return Promise.resolve({ error: null });
      },
      then(resolve: (v: { data: FakeRow[]; error: null }) => void) {
        resolve({ data: project(currentSelection(), cols), error: null });
      },
    };

    return api;
  }

  return { db: { from: (table: string) => builder(table) } as unknown as ApplyDeps["db"], tables };
}

function ctx(payload: unknown): { logger: ReturnType<typeof createLogger>; payload: unknown } {
  return { logger: createLogger({}, { sink: () => undefined }), payload };
}

function batch(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: BATCH,
    organization_id: ORG,
    kind: "PRODUCTS",
    status: "APPLYING",
    parsed_at: "2026-08-20T11:00:00.000Z",
    ...overrides,
  };
}

function okRow(id: number, payload: FakeRow): FakeRow {
  return { id, batch_id: BATCH, status: "OK", payload };
}

describe("aplicação — produtos", () => {
  it("cria SKU novo e marca a linha como aplicada", async () => {
    const { db, tables } = createFakeDb({
      erp_import_batches: [batch()],
      erp_import_rows: [okRow(1, { sku: "PI150", title: "Painel", retailPrice: 174.9 })],
    });

    const outcome = await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(tables.skus).toHaveLength(1);
    expect(tables.skus?.[0]).toMatchObject({ sku: "PI150", sku_key: "PI150", kind: "PRODUTO" });
    expect(tables.erp_import_rows?.[0]).toMatchObject({ apply_status: "APPLIED", apply_reason: null });
    expect(tables.erp_import_batches?.[0]).toMatchObject({ status: "APPLIED", applied_rows: 1, unresolved_rows: 0 });
  });

  it("atualiza SKU existente em vez de duplicar", async () => {
    const { db, tables } = createFakeDb({
      erp_import_batches: [batch()],
      erp_import_rows: [okRow(1, { sku: "PI150", title: "Painel novo" })],
      skus: [{ id: "sku-1", organization_id: ORG, sku: "PI150", sku_key: "PI150", kind: "PRODUTO", title: "Painel velho" }],
    });

    await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    expect(tables.skus).toHaveLength(1);
    expect(tables.skus?.[0]).toMatchObject({ id: "sku-1", title: "Painel novo" });
  });

  it("SKU que já existe como KIT recusa virar PRODUTO, sem tocar o registro", async () => {
    const { db, tables } = createFakeDb({
      erp_import_batches: [batch()],
      erp_import_rows: [okRow(1, { sku: "KIT01", title: "Agora produto?" })],
      skus: [{ id: "sku-1", organization_id: ORG, sku: "KIT01", sku_key: "KIT01", kind: "KIT", title: "Kit original" }],
    });

    await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    expect(tables.skus?.[0]).toMatchObject({ title: "Kit original" });
    expect(tables.erp_import_rows?.[0]).toMatchObject({ apply_status: "FAILED" });
    expect(String(tables.erp_import_rows?.[0]?.apply_reason)).toContain("já existe como KIT");
  });

  it("rodar duas vezes sobre o mesmo lote não duplica o SKU", async () => {
    const { db, tables } = createFakeDb({
      erp_import_batches: [batch()],
      erp_import_rows: [okRow(1, { sku: "PI150", title: "Painel" })],
    });

    await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    // O lote já está APPLIED depois da primeira rodada — reentrega é no-op.
    const outcome = await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(tables.skus).toHaveLength(1);
  });
});

describe("aplicação — kits", () => {
  it("cria o contêiner do kit e o componente, quando o componente já existe", async () => {
    const { db, tables } = createFakeDb({
      erp_import_batches: [batch({ kind: "KITS" })],
      erp_import_rows: [okRow(1, { kitSku: "KIT01", kitSkuKey: "KIT01", kitTitle: "Kit revisão", componentSkuKey: "PI150", quantity: 2 })],
      skus: [{ id: "sku-comp", organization_id: ORG, sku: "PI150", sku_key: "PI150", kind: "PRODUTO" }],
    });

    const outcome = await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    expect(outcome).toEqual({ status: "done", processed: 1 });
    const kit = tables.skus?.find((s) => s.sku_key === "KIT01");

    expect(kit).toMatchObject({ kind: "KIT", title: "Kit revisão" });
    expect(tables.sku_components).toEqual([
      expect.objectContaining({ kit_sku_id: kit?.id, component_sku_id: "sku-comp", quantity: 2 }),
    ]);
    expect(tables.erp_import_rows?.[0]).toMatchObject({ apply_status: "APPLIED" });
  });

  it("componente ainda não importado vira pendência, não erro", async () => {
    const { db, tables } = createFakeDb({
      erp_import_batches: [batch({ kind: "KITS" })],
      erp_import_rows: [okRow(1, { kitSku: "KIT01", kitSkuKey: "KIT01", componentSkuKey: "FALTANDO", quantity: 1 })],
    });

    await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    expect(tables.sku_components ?? []).toHaveLength(0);
    expect(tables.erp_import_rows?.[0]).toMatchObject({ apply_status: "UNRESOLVED" });
    expect(tables.erp_import_batches?.[0]).toMatchObject({ unresolved_rows: 1, applied_rows: 0 });
  });
});

describe("aplicação — estoque", () => {
  it("grava o saldo com sku_id nulo quando o SKU ainda não existe", async () => {
    const { db, tables } = createFakeDb({
      erp_import_batches: [batch({ kind: "STOCK" })],
      erp_import_rows: [okRow(1, { skuKey: "FA100", warehouse: "ESTOQUE LOJA", onHand: 10, available: 8, reserved: 2, inTransit: 0 })],
    });

    await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    expect(tables.erp_stock_snapshots).toEqual([
      expect.objectContaining({ sku_key: "FA100", sku_id: null, on_hand: 10, available: 8 }),
    ]);
    expect(tables.erp_import_rows?.[0]).toMatchObject({ apply_status: "APPLIED" });
  });

  it("resolve sku_id quando o SKU já existe no catálogo", async () => {
    const { db, tables } = createFakeDb({
      erp_import_batches: [batch({ kind: "STOCK" })],
      erp_import_rows: [okRow(1, { skuKey: "FA100", warehouse: "ESTOQUE LOJA", onHand: 10, available: 10, reserved: 0, inTransit: 0 })],
      skus: [{ id: "sku-fa100", organization_id: ORG, sku: "FA100", sku_key: "FA100", kind: "PRODUTO" }],
    });

    await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    expect(tables.erp_stock_snapshots?.[0]).toMatchObject({ sku_id: "sku-fa100" });
  });
});

describe("aplicação — vínculos", () => {
  const LINK_PAYLOAD = {
    skuKey: "PI150",
    storeSlug: "speedbikers-loja-1",
    storeLabel: "Speedbikers (loja 1)",
    channelSku: null,
    ref: { kind: "ITEM" as const, itemId: "MLB1722724235", variationId: "205704879161" },
  };

  it("cria a conta em PENDING e o vínculo, quando o SKU já existe", async () => {
    const { db, tables } = createFakeDb({
      erp_import_batches: [batch({ kind: "LINKS" })],
      erp_import_rows: [okRow(1, LINK_PAYLOAD)],
      skus: [{ id: "sku-pi150", organization_id: ORG, sku: "PI150", sku_key: "PI150", kind: "PRODUTO" }],
    });

    const outcome = await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(tables.ml_accounts).toEqual([
      expect.objectContaining({ slug: "speedbikers-loja-1", status: "PENDING", created_by_import: true }),
    ]);
    expect(tables.sku_listing_links).toEqual([
      expect.objectContaining({ sku_id: "sku-pi150", item_id: "MLB1722724235", source: "IMPORT_UPSELLER" }),
    ]);
  });

  it("SKU ainda não importado vira pendência e registra candidato para a Central de Vinculações", async () => {
    const { db, tables } = createFakeDb({
      erp_import_batches: [batch({ kind: "LINKS" })],
      erp_import_rows: [okRow(1, LINK_PAYLOAD)],
    });

    await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    expect(tables.sku_listing_links ?? []).toHaveLength(0);
    expect(tables.erp_import_rows?.[0]).toMatchObject({ apply_status: "UNRESOLVED" });
    expect(tables.link_candidates).toEqual([
      expect.objectContaining({
        source: "ERP_IMPORT",
        source_row_id: 1,
        sku_key: "PI150",
        item_id: "MLB1722724235",
        status: "OPEN",
      }),
    ]);
  });

  it("reprocessar a mesma linha não duplica o candidato", async () => {
    const { db, tables } = createFakeDb({
      erp_import_batches: [batch({ kind: "LINKS" })],
      erp_import_rows: [okRow(1, LINK_PAYLOAD)],
    });

    await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    // O lote já está APPLIED; simula uma segunda rodada como a reconciliação faria.
    tables.erp_import_batches![0]!.status = "APPLYING";
    await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    expect(tables.link_candidates).toHaveLength(1);
  });

  it("um PRODUCTS aplicado depois resolve o candidato sozinho — match exato", async () => {
    const PRODUCTS_BATCH = "b2000000-0000-4000-8000-00000000000b";

    const { db, tables } = createFakeDb({
      erp_import_batches: [batch({ kind: "LINKS" })],
      erp_import_rows: [okRow(1, LINK_PAYLOAD)],
    });

    // 1. Lote de vínculos: SKU ainda não existe, vira candidato aberto.
    await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    expect(tables.link_candidates?.[0]).toMatchObject({ status: "OPEN" });

    // 2. Um lote de produtos, diferente, cria o SKU que faltava.
    tables.erp_import_batches!.push({ ...batch({ kind: "PRODUCTS" }), id: PRODUCTS_BATCH });
    tables.erp_import_rows!.push({ id: 2, batch_id: PRODUCTS_BATCH, status: "OK", payload: { sku: "PI150" } });

    const outcome = await createErpImportApplyHandler({ db })(
      ENVELOPE,
      ctx({ batchId: PRODUCTS_BATCH }),
    );

    expect(outcome).toEqual({ status: "done", processed: 1 });

    // A reconciliação, no fim do apply de PRODUCTS, fechou o candidato sozinha.
    expect(tables.link_candidates?.[0]).toMatchObject({
      status: "RESOLVED",
      resolution_method: "EXACT_MATCH",
    });
    expect(tables.sku_listing_links).toEqual([
      expect.objectContaining({ item_id: "MLB1722724235", source: "IMPORT_UPSELLER" }),
    ]);
  });

  it("não sobrescreve um vínculo confirmado manualmente", async () => {
    const { db, tables } = createFakeDb({
      erp_import_batches: [batch({ kind: "LINKS" })],
      erp_import_rows: [okRow(1, LINK_PAYLOAD)],
      skus: [
        { id: "sku-pi150", organization_id: ORG, sku: "PI150", sku_key: "PI150", kind: "PRODUTO" },
        { id: "sku-outro", organization_id: ORG, sku: "OUTRO", sku_key: "OUTRO", kind: "PRODUTO" },
      ],
      ml_accounts: [{ id: "acc-1", organization_id: ORG, slug: "speedbikers-loja-1", label: "Speedbikers (loja 1)", status: "CONNECTED" }],
      sku_listing_links: [
        {
          id: "link-1",
          organization_id: ORG,
          ml_account_id: "acc-1",
          ref_kind: "ITEM",
          item_id: "MLB1722724235",
          variation_id: "205704879161",
          user_product_id: null,
          sku_id: "sku-outro",
          channel_sku: null,
          source: "MANUAL",
        },
      ],
    });

    await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    // Continua apontando para o SKU que o humano escolheu, não para o do arquivo.
    expect(tables.sku_listing_links?.[0]).toMatchObject({ sku_id: "sku-outro", source: "MANUAL" });
    expect(tables.erp_import_rows?.[0]).toMatchObject({ apply_status: "APPLIED" });
  });

  it("atualiza um vínculo que veio de importação anterior quando o SKU mudou", async () => {
    const { db, tables } = createFakeDb({
      erp_import_batches: [batch({ kind: "LINKS" })],
      erp_import_rows: [okRow(1, LINK_PAYLOAD)],
      skus: [{ id: "sku-pi150", organization_id: ORG, sku: "PI150", sku_key: "PI150", kind: "PRODUTO" }],
      ml_accounts: [{ id: "acc-1", organization_id: ORG, slug: "speedbikers-loja-1", label: "Speedbikers (loja 1)", status: "CONNECTED" }],
      sku_listing_links: [
        {
          id: "link-1",
          organization_id: ORG,
          ml_account_id: "acc-1",
          ref_kind: "ITEM",
          item_id: "MLB1722724235",
          variation_id: "205704879161",
          user_product_id: null,
          sku_id: "sku-velho",
          channel_sku: null,
          source: "IMPORT_UPSELLER",
        },
      ],
    });

    await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    expect(tables.sku_listing_links?.[0]).toMatchObject({ id: "link-1", sku_id: "sku-pi150" });
    expect(tables.sku_listing_links).toHaveLength(1);
  });
});

describe("guardas do lote", () => {
  it("lote que não está em APPLYING é recusado sem tocar em nada", async () => {
    const { db, tables } = createFakeDb({
      erp_import_batches: [batch({ status: "PARSED" })],
      erp_import_rows: [okRow(1, { sku: "PI150" })],
    });

    const outcome = await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(tables.skus ?? []).toHaveLength(0);
  });

  it("payload sem batchId é falha definitiva", async () => {
    const { db } = createFakeDb({});

    const outcome = await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ nada: true }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });

  it("lote inexistente é falha definitiva", async () => {
    const { db } = createFakeDb({});

    const outcome = await createErpImportApplyHandler({ db })(ENVELOPE, ctx({ batchId: BATCH }));

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });
});
