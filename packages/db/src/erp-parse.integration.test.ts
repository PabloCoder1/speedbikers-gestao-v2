import { randomBytes, randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dbUrl = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const orgId = randomUUID();
const parsedAt = "2026-11-19T13:00:00Z";
const admin = new Client({ connectionString: dbUrl });
let fixtureCreated = false;

beforeAll(async () => {
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (!loopback.has(new URL(dbUrl).hostname) || !loopback.has(new URL(apiUrl).hostname) || !key) {
    throw new Error("Teste de ERP exige Postgres e PostgREST locais com chave de serviço.");
  }
  await admin.connect();
  await admin.query("insert into public.organizations (id, name, slug) values ($1, 'ERP teste', $1::uuid::text)", [orgId]);
  fixtureCreated = true;
});

afterAll(async () => {
  try {
    if (fixtureCreated) {
      await admin.query("delete from public.organizations where id = $1", [orgId]);
    }
  } finally {
    await admin.end();
  }
});

async function criarLote() {
  const id = randomUUID();
  const result = await admin.query<{ version: string }>(
    `insert into public.erp_import_batches (id, organization_id, kind, status, storage_path, content_hash)
     values ($1, $2, 'STOCK', 'PARSING', 'fixture.xlsx', $3) returning updated_at::text as version`,
    [id, orgId, randomBytes(32).toString("hex")],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Lote de teste não criado.");
  return { id, version: row.version };
}

function linha(rowNumber: number, status = "OK", description = "nova conferência") {
  return {
    row_number: rowNumber,
    status,
    reason: status === "OK" ? null : "fixture",
    sku_key: `SKU-${String(rowNumber)}`,
    payload: { description },
  };
}

async function rpc(
  name: "stage_erp_parse_chunk" | "publish_erp_parse",
  batch: { id: string; version: string },
  args: object,
) {
  const response = await fetch(new URL(`/rest/v1/rpc/${name}`, apiUrl), {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_batch_id: batch.id, p_parse_version: batch.version, ...args }),
  });
  const payload: unknown = await response.json();
  return response.ok ? { data: payload, error: null } : { data: null, error: payload };
}

async function preparar(batch: { id: string; version: string }, offset: number, rows: ReturnType<typeof linha>[]) {
  return rpc("stage_erp_parse_chunk", batch, { p_offset: offset, p_rows: rows });
}

async function publicar(batch: { id: string; version: string }, expected: number) {
  return rpc("publish_erp_parse", batch, { p_expected_rows: expected, p_parsed_at: parsedAt });
}

async function contarBlocos(batchId: string) {
  const result = await admin.query<{ count: number }>(
    "select count(*)::int as count from private.erp_parse_chunks where batch_id = $1",
    [batchId],
  );
  return result.rows[0]?.count;
}

describe("publicação atômica da conferência ERP", () => {
  it("publica uma tentativa em blocos no volume histórico e descarta as demais", async () => {
    const first = await criarLote();
    expect(await preparar(first, 0, [linha(2)])).toEqual({ data: true, error: null });
    const claimed = await admin.query<{ version: string }>(
      "update public.erp_import_batches set status = 'PARSING' where id = $1 returning updated_at::text as version",
      [first.id],
    );
    const row = claimed.rows[0];
    if (row === undefined) throw new Error("Segunda tentativa sem versão.");
    const active = { id: first.id, version: row.version };
    expect(await contarBlocos(first.id)).toBe(0);
    expect(await preparar(first, 0, [linha(2)])).toEqual({ data: false, error: null });
    expect(await publicar(first, 1)).toEqual({ data: [], error: null });

    const total = 23_924;
    const description = "x".repeat(1_080);
    for (let offset = 0; offset < total; offset += 1_000) {
      const count = Math.min(1_000, total - offset);
      const rows = Array.from({ length: count }, (_, index) => linha(offset + index + 2, "OK", description));
      expect(await preparar(active, offset, rows)).toEqual({ data: true, error: null });
    }
    expect(await contarBlocos(first.id)).toBe(24);
    const before = await admin.query("select count(*)::int as count from public.erp_import_rows where batch_id = $1", [first.id]);
    expect(before.rows).toEqual([{ count: 0 }]);

    const counts = { total_rows: total, ok_rows: total, skipped_rows: 0, invalid_rows: 0 };
    const outcomes = await Promise.all([publicar(active, total), publicar(active, total)]);
    expect(outcomes).toContainEqual({ data: [counts], error: null });
    expect(outcomes).toContainEqual({ data: [], error: null });

    const after = await admin.query(
      `select b.status, b.total_rows, b.ok_rows, b.skipped_rows, b.invalid_rows,
              count(r.id)::int as visible, max(r.row_number) as last
         from public.erp_import_batches b join public.erp_import_rows r on r.batch_id = b.id
        where b.id = $1 group by b.id`,
      [first.id],
    );
    expect(after.rows).toEqual([{ ...counts, status: "PARSED", visible: total, last: total + 1 }]);
    expect(await contarBlocos(first.id)).toBe(0);
  }, 30_000);

  it("reverte a substituição de linhas e snapshots quando falta uma posição", async () => {
    const batch = await criarLote();
    await admin.query(
      `insert into public.erp_import_rows (batch_id, row_number, status, payload, sku_key)
       values ($1, 2, 'OK', '{}', 'anterior')`,
      [batch.id],
    );
    await admin.query(
      `insert into public.erp_stock_snapshots
        (batch_id, organization_id, sku_key, warehouse, on_hand, available, captured_at)
       values ($1, $2, 'anterior', 'LOJA', 1, 1, now())`,
      [batch.id, orgId],
    );

    expect(await preparar(batch, 0, [linha(2), linha(4)])).toEqual({ data: true, error: null });
    expect((await publicar(batch, 2)).error).toMatchObject({ code: "22023" });
    const existing = await admin.query(
      `select b.status, b.updated_at::text as version, r.sku_key, s.sku_key as snapshot
         from public.erp_import_batches b
         join public.erp_import_rows r on r.batch_id = b.id
         join public.erp_stock_snapshots s on s.batch_id = b.id
        where b.id = $1`,
      [batch.id],
    );
    expect(existing.rows).toEqual([{ status: "PARSING", version: batch.version, sku_key: "anterior", snapshot: "anterior" }]);

    const corrected = [linha(2), linha(3, "SKIPPED"), linha(4, "INVALID")];
    expect(await preparar(batch, 0, corrected)).toEqual({ data: true, error: null });
    expect(await preparar(batch, 0, corrected)).toEqual({ data: true, error: null });
    expect(await publicar(batch, 3)).toEqual({
      data: [{ total_rows: 3, ok_rows: 1, skipped_rows: 1, invalid_rows: 1 }], error: null,
    });
    const snapshots = await admin.query("select count(*)::int as count from public.erp_stock_snapshots where batch_id = $1", [batch.id]);
    expect(snapshots.rows).toEqual([{ count: 0 }]);
    expect(await contarBlocos(batch.id)).toBe(0);
  });

  it("publica um arquivo com cabeçalho e sem linhas", async () => {
    const batch = await criarLote();
    expect(await publicar(batch, 0)).toEqual({
      data: [{ total_rows: 0, ok_rows: 0, skipped_rows: 0, invalid_rows: 0 }], error: null,
    });
  });

  it("restringe as duas RPCs ao papel do worker", async () => {
    const result = await admin.query(
      `select has_function_privilege('anon', f, 'execute') as anon,
              has_function_privilege('authenticated', f, 'execute') as authenticated,
              has_function_privilege('service_role', f, 'execute') as service_role
         from (values
           ('public.stage_erp_parse_chunk(uuid,timestamptz,integer,jsonb)'::regprocedure),
           ('public.publish_erp_parse(uuid,timestamptz,integer,timestamptz)'::regprocedure)
         ) signatures(f)`,
    );
    expect(result.rows).toEqual(Array.from({ length: 2 }, () => ({ anon: false, authenticated: false, service_role: true })));
  });
});
