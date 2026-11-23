import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * D-795 — o produto que sai da planilha de produtos do UpSeller fica FORA DO
 * CATÁLOGO, nunca apagado. Provado contra o Postgres real.
 *
 * O que só o banco prova: o conjunto de `products_batch_absent_sku_ids` (só o
 * PRODUTO que já veio numa planilha aplicada; nem o criado fora dela, nem o
 * KIT), que a prévia da conferência e a marcação contam o MESMO conjunto, a
 * idempotência da marcação, a volta de quem reaparece, os grants (a marcação é
 * só do worker) e o recorte da Reposição em `get_purchase_suggestions`.
 *
 * Exige o Supabase local no ar (`pnpm exec supabase start`).
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const ORG = randomUUID();
const ADMIN = randomUUID();
const PREFIXO = `d793-${ORG.slice(0, 8)}`;

let client: Client;

const sku: Record<"a" | "b" | "c" | "d" | "kit", string> = { a: "", b: "", c: "", d: "", kit: "" };
let loteAntigo = "";
let loteNovo = "";

interface Previa {
  conhecidos: number;
  ausentes: number;
  jaMarcados: number;
  comSaldo: number;
  comVinculo: number;
  voltam: number;
  amostra: { sku: string; saldo: number | null; comVinculo: boolean; foraDesde: string | null }[];
}

async function umId(sql: string, params: unknown[]): Promise<string> {
  const result = await client.query<{ id: string }>(sql, params);
  const id = result.rows[0]?.id;

  if (id === undefined) throw new Error(`fixture sem id: ${sql}`);

  return id;
}

async function novoSku(chave: string, kind: "PRODUTO" | "KIT" = "PRODUTO"): Promise<string> {
  return umId(
    `insert into public.skus (organization_id, sku, kind, title) values ($1, $2, $3, $4) returning id`,
    [ORG, `${PREFIXO}-${chave}`.toUpperCase(), kind, `Produto ${chave}`],
  );
}

function chaveDe(chave: string): string {
  return `${PREFIXO}-${chave}`.toUpperCase();
}

async function novoLote(nome: string, kind = "PRODUCTS"): Promise<string> {
  return umId(
    `insert into public.erp_import_batches (organization_id, kind, storage_path, content_hash, file_name, status, parsed_at)
     values ($1, $2, $3, md5($3) || md5($3), $4, 'PARSED', now()) returning id`,
    [ORG, kind, `erp-imports/${PREFIXO}/${nome}`, nome],
  );
}

async function aplicarLote(loteId: string): Promise<void> {
  await client.query(
    `update public.erp_import_batches set status = 'APPLIED', applied_at = now(), applied_by = $2 where id = $1`,
    [loteId, ADMIN],
  );
}

/** Linhas OK do lote, uma por chave, com o resultado da aplicação. */
async function linhas(loteId: string, chaves: readonly string[], applyStatus: string | null): Promise<void> {
  let numero = 2;

  for (const chave of chaves) {
    await client.query(
      `insert into public.erp_import_rows (batch_id, row_number, status, sku_key, payload, apply_status)
       values ($1, $2, 'OK', $3, '{}'::jsonb, $4)`,
      [loteId, numero, chaveDe(chave), applyStatus],
    );
    numero += 1;
  }
}

async function comoPapel<T>(papel: "authenticated" | "service_role", sql: string, params: unknown[] = []): Promise<T[]> {
  await client.query("begin");

  try {
    await client.query(`set local role ${papel}`);

    if (papel === "authenticated") {
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ADMIN })]);
    }

    const result = await client.query(sql, params);

    await client.query("commit");

    return result.rows as T[];
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function previa(loteId: string): Promise<Previa | null> {
  const rows = await comoPapel<{ previa: Previa | null }>(
    "authenticated",
    "select public.get_products_batch_absences($1) as previa",
    [loteId],
  );

  return rows[0]?.previa ?? null;
}

async function marcar(loteId: string, marcar: boolean): Promise<{ marked: number; cleared: number }> {
  const rows = await comoPapel<{ r: { marked: number; cleared: number } }>(
    "service_role",
    "select public.apply_products_batch_absences($1, $2) as r",
    [loteId, marcar],
  );
  const r = rows[0]?.r;

  if (r === undefined) throw new Error("marcação sem retorno");

  return r;
}

async function estado(skuId: string): Promise<{ is_active: boolean; erp_absent_since: Date | null; erp_absent_batch_id: string | null }> {
  const result = await client.query<{ is_active: boolean; erp_absent_since: Date | null; erp_absent_batch_id: string | null }>(
    "select is_active, erp_absent_since, erp_absent_batch_id from public.skus where id = $1",
    [skuId],
  );
  const row = result.rows[0];

  if (row === undefined) throw new Error("sku sumiu");

  return row;
}

async function contagens(loteId: string): Promise<{ absent_marked: number | null; absent_cleared: number | null }> {
  const result = await client.query<{ absent_marked: number | null; absent_cleared: number | null }>(
    "select absent_marked, absent_cleared from public.erp_import_batches where id = $1",
    [loteId],
  );
  const row = result.rows[0];

  if (row === undefined) throw new Error("lote sumiu");

  return row;
}

beforeAll(async () => {
  client = new Client({ connectionString: DB_URL });
  await client.connect();

  // Tokens como '' e nao NULL: usuario criado por SQL com token nulo envenena a
  // listagem do GoTrue inteira (docs/TESTING.md).
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                             raw_user_meta_data, created_at, updated_at,
                             confirmation_token, recovery_token, email_change, email_change_token_new,
                             email_change_token_current, phone_change, phone_change_token, reauthentication_token)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, 'x', now(),
             '{"full_name":"Admin D-795"}', now(), now(), '', '', '', '', '', '', '', '')`,
    [ADMIN, `${PREFIXO}@d793.test`],
  );
  await client.query(`insert into public.organizations (id, name, slug) values ($1, $2, $3)`, [ORG, PREFIXO, PREFIXO]);
  await client.query(
    `insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'ADMIN')`,
    [ORG, ADMIN],
  );

  sku.a = await novoSku("a");
  sku.b = await novoSku("b");
  sku.c = await novoSku("c");
  // Nasceu fora da planilha (a invoice de D-792 cria assim): nunca é julgado.
  sku.d = await novoSku("d");
  sku.kit = await novoSku("kit", "KIT");

  // A planilha antiga trouxe A, B, C e (por engano de natureza) a chave do kit.
  loteAntigo = await novoLote("antigo.xlsx");
  await linhas(loteAntigo, ["a", "b", "c", "kit"], "APPLIED");
  await aplicarLote(loteAntigo);

  // A nova só traz A. A linha sem SKU (INVALID) não diz de qual produto é.
  loteNovo = await novoLote("novo.xlsx");
  await linhas(loteNovo, ["a"], null);
  await client.query(
    `insert into public.erp_import_rows (batch_id, row_number, status, reason, sku_key, payload)
     values ($1, 99, 'INVALID', 'linha sem SKU', null, '{}'::jsonb)`,
    [loteNovo],
  );

  await client.query(
    `insert into public.inventory_balances (organization_id, sku_id, location_kind, quantity)
     values ($1, $2, 'LOCAL', 5), ($1, $3, 'LOCAL', 0), ($1, $4, 'LOCAL', 3)`,
    [ORG, sku.b, sku.c, sku.a],
  );
});

afterAll(async () => {
  // Sem limpeza, como as outras suítes: o ambiente local acumula até o próximo
  // `supabase db reset`, e cada execução usa uma organização nova.
  await client.end();
});

describe("prévia da conferência", () => {
  it("conta só o PRODUTO que já veio numa planilha aplicada, e diz quem tem saldo", async () => {
    const p = await previa(loteNovo);

    expect(p).toMatchObject({ conhecidos: 3, ausentes: 2, jaMarcados: 0, comSaldo: 1, comVinculo: 0, voltam: 0 });
    expect(p?.amostra.map((m) => m.sku)).toEqual([chaveDe("b"), chaveDe("c")]);
    expect(p?.amostra[0]).toMatchObject({ saldo: 5, comVinculo: false, foraDesde: null });
  });

  it("lote que não é de produtos não tem prévia", async () => {
    const estoque = await novoLote("estoque.xlsx", "STOCK");

    expect(await previa(estoque)).toBeNull();
  });
});

describe("marcação", () => {
  it("é só do worker: o usuário logado não executa", async () => {
    await expect(
      comoPapel("authenticated", "select public.apply_products_batch_absences($1, true)", [loteNovo]),
    ).rejects.toThrow(/permission denied/);
  });

  it("sem p_mark, nada é marcado e o lote registra que não pediu", async () => {
    expect(await marcar(loteNovo, false)).toEqual({ marked: 0, cleared: 0 });
    expect(await estado(sku.b)).toMatchObject({ is_active: true, erp_absent_since: null });
    expect(await contagens(loteNovo)).toEqual({ absent_marked: null, absent_cleared: 0 });
  });

  it("com p_mark, marca exatamente o conjunto da prévia: inativo, com a data e o lote", async () => {
    expect(await marcar(loteNovo, true)).toEqual({ marked: 2, cleared: 0 });

    for (const id of [sku.b, sku.c]) {
      const e = await estado(id);

      expect(e.is_active).toBe(false);
      expect(e.erp_absent_since).not.toBeNull();
      expect(e.erp_absent_batch_id).toBe(loteNovo);
    }

    // Presente, criado fora da planilha e kit: intocados.
    for (const id of [sku.a, sku.d, sku.kit]) {
      expect(await estado(id)).toMatchObject({ is_active: true, erp_absent_since: null });
    }

    expect(await contagens(loteNovo)).toEqual({ absent_marked: 2, absent_cleared: 0 });
  });

  it("rodar de novo (reentrega do job) não marca nem conta duas vezes", async () => {
    const antes = await estado(sku.b);

    expect(await marcar(loteNovo, true)).toEqual({ marked: 0, cleared: 0 });
    expect((await estado(sku.b)).erp_absent_since).toEqual(antes.erp_absent_since);
    expect(await contagens(loteNovo)).toEqual({ absent_marked: 2, absent_cleared: 0 });
  });

  it("a prévia de depois já mostra os dois como marcados", async () => {
    expect(await previa(loteNovo)).toMatchObject({ ausentes: 2, jaMarcados: 2 });
  });
});

describe("Reposição", () => {
  it("o SKU marcado sai de get_purchase_suggestions; o presente continua", async () => {
    const result = await client.query<{ sku_id: string }>(
      "select sku_id from public.get_purchase_suggestions($1, current_date, null, null, 1000, 0, null)",
      [ORG],
    );
    const ids = result.rows.map((r) => r.sku_id);

    expect(ids).toContain(sku.a);
    expect(ids).not.toContain(sku.b);
    expect(ids).not.toContain(sku.c);
  });
});

describe("quem volta", () => {
  it("o SKU que reaparece numa planilha posterior perde a marca; o que segue fora continua", async () => {
    await aplicarLote(loteNovo);

    const loteDeVolta = await novoLote("de-volta.xlsx");

    await linhas(loteDeVolta, ["a", "b"], null);

    expect(await previa(loteDeVolta)).toMatchObject({ voltam: 1, ausentes: 1, jaMarcados: 1 });

    // A aplicação grava o is_active que o UpSeller manda antes da marcação rodar.
    await client.query("update public.skus set is_active = true where id = $1", [sku.b]);

    expect(await marcar(loteDeVolta, false)).toEqual({ marked: 0, cleared: 1 });
    expect(await estado(sku.b)).toMatchObject({ is_active: true, erp_absent_since: null, erp_absent_batch_id: null });
    expect(await estado(sku.c)).toMatchObject({ is_active: false, erp_absent_batch_id: loteNovo });
    expect(await contagens(loteDeVolta)).toEqual({ absent_marked: null, absent_cleared: 1 });
  });
});
