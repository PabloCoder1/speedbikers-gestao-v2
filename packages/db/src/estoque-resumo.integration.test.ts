import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * O Full da faixa de /estoque (`get_stock_summary`, D-870) e do dashboard do SKU
 * (`get_sku_dashboard`, D-871) contra o Postgres de verdade.
 *
 * Sem captura do Full na janela de 3 dias, o banco não sabe quanto há no Full:
 * a faixa recebe nulo, não zero. Com captura, o recorte que não tem SKU nela
 * soma zero de verdade.
 *
 * Organização própria; as capturas saem no fim. Exige o Supabase local no ar.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const ORG = "77777777-0000-4000-8000-00000000d870";
const ADMIN = "aaaaaaaa-0000-4000-8000-00000000d870";
const CONTA = "aaaa8700-0000-4000-8000-00000000aaaa";

let client: Client;
let skuNoFull = "";
let skuForaDoFull = "";

interface Resumo {
  full_quantity: string | null;
  skus_no_recorte: string;
}

async function resumo(search: string | null = null): Promise<Resumo> {
  await client.query("begin");

  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ADMIN })]);
    const result = await client.query<Resumo>("select * from public.get_stock_summary($1, null, null, $2)", [ORG, search]);
    await client.query("rollback");

    const row = result.rows[0];
    if (row === undefined) throw new Error("get_stock_summary sem linha");

    return row;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function fullDoSku(skuId: string): Promise<string | null> {
  await client.query("begin");

  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ADMIN })]);
    const result = await client.query<{ full_quantity: string | null }>(
      "select full_quantity from public.get_sku_dashboard($1, $2, current_date - 30, current_date)",
      [ORG, skuId],
    );
    await client.query("rollback");

    const row = result.rows[0];
    if (row === undefined) throw new Error("get_sku_dashboard sem linha");

    return row.full_quantity;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function capturar(skuId: string, quantidade: number, idade: string): Promise<void> {
  await client.query(
    `insert into public.fulfillment_stock_snapshots (organization_id, ml_account_id, inventory_id, item_id, sku_id, quantity, captured_at)
     values ($1, $2, 'D870-INV', 'MLB987000870', $3, $4, now() - $5::interval)`,
    [ORG, CONTA, skuId, quantidade, idade],
  );
}

beforeAll(async () => {
  client = new Client({ connectionString: DB_URL });
  await client.connect();

  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-d870@rls.test', 'x', now(), '{}', now(), now())
     on conflict (id) do nothing`,
    [ADMIN],
  );
  await client.query("insert into public.organizations (id, name, slug) values ($1, 'Org D-870', 'org-d870') on conflict (id) do nothing", [ORG]);
  await client.query("insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'ADMIN') on conflict do nothing", [
    ORG,
    ADMIN,
  ]);
  await client.query(
    `insert into public.ml_accounts (id, organization_id, label, slug, seller_id, status, connected_at)
     values ($1, $2, 'Conta D-870', 'd870-conta', 8701, 'CONNECTED', now())
     on conflict do nothing`,
    [CONTA, ORG],
  );

  const skus = await client.query<{ id: string; sku_key: string }>(
    `insert into public.skus (organization_id, sku, kind, purchase_cost)
     values ($1, 'D870-NOFULL', 'PRODUTO', null), ($1, 'D870-FORA', 'PRODUTO', null)
     on conflict on constraint skus_org_key_unique do update set sku = excluded.sku
     returning id, sku_key`,
    [ORG],
  );

  skuNoFull = skus.rows.find((r) => r.sku_key === "D870-NOFULL")?.id ?? "";
  skuForaDoFull = skus.rows.find((r) => r.sku_key === "D870-FORA")?.id ?? "";
});

afterAll(async () => {
  // Como as outras suítes de organização própria: org, conta e SKUs ficam (os
  // inserts são idempotentes), e o que o teste mede, as capturas, sai.
  await client.query("delete from public.fulfillment_stock_snapshots where organization_id = $1", [ORG]);
  await client.end();
});

describe("Full desconhecido sem captura: /estoque (D-870) e dashboard do SKU (D-871)", () => {
  it("sem captura nenhuma, o Full é desconhecido (nulo), não zero", async () => {
    const r = await resumo();

    expect(Number(r.skus_no_recorte)).toBe(2);
    expect(r.full_quantity).toBeNull();
    // O dashboard do SKU segue a mesma regra (D-871).
    expect(await fullDoSku(skuNoFull)).toBeNull();
    expect(await fullDoSku(skuForaDoFull)).toBeNull();
  });

  it("captura fora da janela de 3 dias continua desconhecida", async () => {
    await capturar(skuNoFull, 9, "5 days");

    expect((await resumo()).full_quantity).toBeNull();
    expect(await fullDoSku(skuNoFull)).toBeNull();
  });

  it("com captura na janela, soma a última por bucket, e o recorte fora do Full é zero de verdade", async () => {
    await capturar(skuNoFull, 7, "1 hour");

    // A captura de 1 h vence a de 5 dias no mesmo bucket.
    expect(Number((await resumo()).full_quantity)).toBe(7);

    // O SKU sem captura está fora do Full: a organização capturou, então 0 é medida.
    const fora = await resumo("D870-FORA");
    expect(Number(fora.skus_no_recorte)).toBe(1);
    expect(fora.full_quantity).not.toBeNull();
    expect(Number(fora.full_quantity)).toBe(0);

    // No dashboard do SKU: o do Full soma a última captura; o de fora é 0 medido.
    expect(Number(await fullDoSku(skuNoFull))).toBe(7);
    const skuFora = await fullDoSku(skuForaDoFull);
    expect(skuFora).not.toBeNull();
    expect(Number(skuFora)).toBe(0);
  });
});
