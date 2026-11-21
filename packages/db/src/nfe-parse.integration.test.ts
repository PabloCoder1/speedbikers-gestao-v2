import { randomBytes, randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dbUrl = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const orgId = randomUUID();
const parsedAt = "2026-11-19T12:00:00Z";

const admin = new Client({ connectionString: dbUrl });
let fixtureCreated = false;

beforeAll(async () => {
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (!loopback.has(new URL(dbUrl).hostname) || !loopback.has(new URL(apiUrl).hostname) || !key) {
    throw new Error("Teste de NF-e exige Postgres e PostgREST locais com chave de serviço.");
  }

  await admin.connect();
  await admin.query("insert into public.organizations (id, name, slug) values ($1, 'NF-e teste', $1::uuid::text)", [orgId]);
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

async function criarDocumento() {
  const id = randomUUID();
  const result = await admin.query<{ version: string }>(
    `insert into public.documents (id, organization_id, status, storage_path, content_hash)
     values ($1, $2, 'PARSING', 'fixture.xml', $3) returning updated_at::text as version`,
    [id, orgId, randomBytes(32).toString("hex")],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Documento de teste não criado.");
  return { id, version: row.version };
}

function item(position: number, description: string) {
  return { position, supplier_code: "FIXTURE", description, quantity: 1, unit: null, unit_value: null, total_value: null };
}

async function persistir(
  document: { id: string; version: string },
  items: ReturnType<typeof item>[],
  header: { document_number?: string; access_key?: string } = {},
) {
  const response = await fetch(new URL("/rest/v1/rpc/persist_nfe_parse", apiUrl), {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_document_id: document.id,
      p_parse_version: document.version,
      p_header: header,
      p_items: items,
      p_parsed_at: parsedAt,
      p_error: null,
      p_error_code: null,
    }),
  });
  const payload: unknown = await response.json();
  return response.ok ? { data: payload, error: null } : { data: null, error: payload };
}

describe("persistência atômica da leitura de NF-e", () => {
  it("aceita só a versão atual e grava todos os itens acima do limite de leitura", async () => {
    const first = await criarDocumento();
    const claimed = await admin.query<{ version: string }>(
      "update public.documents set status = 'PARSING' where id = $1 returning updated_at::text as version",
      [first.id],
    );
    const row = claimed.rows[0];
    if (row === undefined) throw new Error("Segunda entrega sem versão.");
    const second = { id: first.id, version: row.version };
    expect(second.version).not.toBe(first.version);

    const items = Array.from({ length: 1_001 }, (_, index) => item(index, "segunda entrega"));
    const [stale, current] = await Promise.all([
      persistir(first, [item(0, "primeira entrega")], { document_number: "1" }),
      persistir(second, items, { document_number: "2" }),
    ]);
    expect(stale).toMatchObject({ data: false, error: null });
    expect(current).toMatchObject({ data: true, error: null });
    expect(await persistir(second, [item(0, "reenvio")])).toMatchObject({ data: false, error: null });

    const result = await admin.query(
      `select d.status, d.document_number, d.total_items, d.resolved_items,
              count(i.id)::int as items, count(i.sku_id)::int as linked,
              min(i.description) as description
         from public.documents d join public.document_items i on i.document_id = d.id
        where d.id = $1 group by d.id`,
      [first.id],
    );
    expect(result.rows).toEqual([{
      status: "PARSED", document_number: "2", total_items: 1_001, resolved_items: 0,
      items: 1_001, linked: 0, description: "segunda entrega",
    }]);
  });

  it("reverte a troca de itens quando a validação final do cabeçalho falha", async () => {
    const document = await criarDocumento();
    await admin.query(
      `insert into public.document_items (document_id, position, supplier_code, description, quantity)
       values ($1, 0, 'FIXTURE', 'item anterior', 1)`,
      [document.id],
    );

    const failed = await persistir(document, [item(0, "item novo")], { access_key: "inválida" });
    expect(failed.error).toMatchObject({ code: "23514" });

    const result = await admin.query(
      `select d.status, d.updated_at::text as version, i.description
         from public.documents d join public.document_items i on i.document_id = d.id
        where d.id = $1`,
      [document.id],
    );
    expect(result.rows).toEqual([{ status: "PARSING", version: document.version, description: "item anterior" }]);
    expect(await persistir(document, [item(0, "item recuperado")])).toMatchObject({ data: true, error: null });
  });

  it("restringe a execução ao papel do worker", async () => {
    const result = await admin.query(
      `select has_function_privilege('anon', f, 'execute') as anon,
              has_function_privilege('authenticated', f, 'execute') as authenticated,
              has_function_privilege('service_role', f, 'execute') as service_role
         from (select 'public.persist_nfe_parse(uuid,timestamptz,jsonb,jsonb,timestamptz,text,text)'::regprocedure as f) signature`,
    );
    expect(result.rows).toEqual([{ anon: false, authenticated: false, service_role: true }]);
  });
});
