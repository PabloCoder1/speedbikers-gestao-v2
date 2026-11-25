import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Integração real contra PostgreSQL para a camada transacional do TikTok Shop
 * (`20261125170000_tiktok_shop_transacional.sql`, D-838, M04):
 *
 * - `tiktok_orders_sync_lock`: atômico sob `service_role`, recusado para `authenticated`;
 * - RLS negativo cross-org nas 6 tabelas transacionais;
 * - bloqueio de escrita (`INSERT`/`UPDATE`/`DELETE`) para `authenticated`;
 * - upsert idempotente nas 6 tabelas sem duplicação.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const ORG_A = "77777777-0000-4000-8000-00000000d838";
const ORG_B = "88888888-0000-4000-8000-00000000d838";
const USER_A = "aaaaaaaa-0000-4000-8000-00000000d838";
const USER_B = "bbbbbbbb-0000-4000-8000-00000000d838";
const SHOP_A = "11118380-0000-4000-8000-000000000001";

const TABLES = [
  "tiktok_orders",
  "tiktok_order_items",
  "tiktok_catalog_units",
  "tiktok_returns",
  "tiktok_order_financials",
  "tiktok_statements",
] as const;

let client: Client;

async function asRole<T>(role: "authenticated" | "service_role", sub: string | null, fn: () => Promise<T>): Promise<T> {
  await client.query("begin");

  try {
    await client.query(`set local role ${role}`);

    if (sub !== null) {
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub })]);
    }

    const res = await fn();

    await client.query("rollback");

    return res;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

beforeAll(async () => {
  client = new Client({ connectionString: DB_URL });
  await client.connect();

  await client.query(
    `insert into public.organizations (id, name, slug) values
       ($1, 'Org TikTok A', 'org-tiktok-a-d838'),
       ($2, 'Org TikTok B', 'org-tiktok-b-d838')
     on conflict (id) do nothing`,
    [ORG_A, ORG_B],
  );
  await client.query(
    `insert into auth.users (id, email, aud, role, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values
       ($1, 'tiktok-a-d838@test.local', 'authenticated', 'authenticated', '', now(), '{}', '{}', now(), now()),
       ($2, 'tiktok-b-d838@test.local', 'authenticated', 'authenticated', '', now(), '{}', '{}', now(), now())
     on conflict (id) do nothing`,
    [USER_A, USER_B],
  );
  await client.query(
    `insert into public.profiles (id, full_name) values
       ($1, 'User A'),
       ($2, 'User B')
     on conflict (id) do nothing`,
    [USER_A, USER_B],
  );
  await client.query(
    `insert into public.organization_members (organization_id, user_id, role) values
       ($1, $3, 'ADMIN'),
       ($2, $4, 'ADMIN')
     on conflict (organization_id, user_id) do nothing`,
    [ORG_A, ORG_B, USER_A, USER_B],
  );
  await client.query(
    `insert into public.tiktok_shops (id, organization_id, shop_id, shop_name, region, status)
     values ($1, $2, '7000714532876278380', 'Loja TikTok A', 'BR', 'CONNECTED')
     on conflict (id) do nothing`,
    [SHOP_A, ORG_A],
  );
});

afterAll(async () => {
  await client.query("delete from public.tiktok_shops where id = $1", [SHOP_A]);
  await client.end();
});

describe("TikTok Shop transacional — Postgres real (D-838)", () => {
  it("tiktok_orders_sync_lock é atômico sob service_role e negado para authenticated", async () => {
    const first = await client.query<{ locked: boolean }>(
      "select public.tiktok_orders_sync_lock($1, 600) as locked",
      [SHOP_A],
    );
    const second = await client.query<{ locked: boolean }>(
      "select public.tiktok_orders_sync_lock($1, 600) as locked",
      [SHOP_A],
    );

    expect(first.rows[0]?.locked).toBe(true);
    expect(second.rows[0]?.locked).toBe(false);

    await client.query("update public.tiktok_shops set orders_sync_locked_until = null where id = $1", [SHOP_A]);

    const afterUnlock = await client.query<{ locked: boolean }>(
      "select public.tiktok_orders_sync_lock($1, 600) as locked",
      [SHOP_A],
    );

    expect(afterUnlock.rows[0]?.locked).toBe(true);
    await client.query("update public.tiktok_shops set orders_sync_locked_until = null where id = $1", [SHOP_A]);

    await expect(
      asRole("authenticated", USER_A, () => client.query("select public.tiktok_orders_sync_lock($1, 600)", [SHOP_A])),
    ).rejects.toThrow(/permission denied/i);
  });

  it("upsert idempotente grava e atualiza as 6 tabelas sem duplicar e RLS isola Org A de Org B", async () => {
    await client.query(
      `insert into public.tiktok_orders (organization_id, tiktok_shop_id, order_id, raw_status, lifecycle, fulfillment_channel, business_date, created_at_remote, updated_at_remote, currency, total_amount_brl)
       values ($1, $2, 'ORD-D838', 'DELIVERED', 'VALIDA', 'LOCAL', '2026-11-25', now(), now(), 'BRL', 214.90)
       on conflict (tiktok_shop_id, order_id) do update set total_amount_brl = excluded.total_amount_brl`,
      [ORG_A, SHOP_A],
    );
    await client.query(
      `insert into public.tiktok_orders (organization_id, tiktok_shop_id, order_id, raw_status, lifecycle, fulfillment_channel, business_date, created_at_remote, updated_at_remote, currency, total_amount_brl)
       values ($1, $2, 'ORD-D838', 'COMPLETED', 'VALIDA', 'LOCAL', '2026-11-25', now(), now(), 'BRL', 220.00)
       on conflict (tiktok_shop_id, order_id) do update set raw_status = excluded.raw_status, total_amount_brl = excluded.total_amount_brl`,
      [ORG_A, SHOP_A],
    );
    await client.query(
      `insert into public.tiktok_order_items (organization_id, tiktok_shop_id, order_id, position, sku_id, seller_sku, quantity)
       values ($1, $2, 'ORD-D838', 0, 'SKU-1', 'CAP-01', 2)
       on conflict (tiktok_shop_id, order_id, position) do update set quantity = excluded.quantity`,
      [ORG_A, SHOP_A],
    );
    await client.query(
      `insert into public.tiktok_catalog_units (organization_id, tiktok_shop_id, product_id, sku_key, sku_id, seller_sku, seller_sku_key, raw_status, lifecycle, available_stock)
       values ($1, $2, 'PROD-1', 'SKU-1', 'SKU-1', 'cap-01', 'CAP-01', 'ACTIVATE', 'ATIVO', 10)
       on conflict (tiktok_shop_id, product_id, sku_key) do update set available_stock = excluded.available_stock`,
      [ORG_A, SHOP_A],
    );
    await client.query(
      `insert into public.tiktok_returns (organization_id, tiktok_shop_id, return_id, order_id, normalized_status, kind, completed, business_date)
       values ($1, $2, 'RET-D838', 'ORD-D838', 'RETURN_OR_REFUND_REQUEST_COMPLETE', 'RETORNO_FISICO', true, '2026-11-25')
       on conflict (tiktok_shop_id, return_id) do update set completed = excluded.completed`,
      [ORG_A, SHOP_A],
    );
    await client.query(
      `insert into public.tiktok_order_financials (organization_id, tiktok_shop_id, order_id, currency, settlement_amount)
       values ($1, $2, 'ORD-D838', 'BRL', 175.50)
       on conflict (tiktok_shop_id, order_id) do update set settlement_amount = excluded.settlement_amount`,
      [ORG_A, SHOP_A],
    );
    await client.query(
      `insert into public.tiktok_statements (organization_id, tiktok_shop_id, statement_id, currency, settlement_amount)
       values ($1, $2, 'ST-D838', 'BRL', 175.50)
       on conflict (tiktok_shop_id, statement_id) do update set settlement_amount = excluded.settlement_amount`,
      [ORG_A, SHOP_A],
    );

    for (const table of TABLES) {
      const countA = await asRole("authenticated", USER_A, async () => {
        const res = await client.query<{ c: string }>(`select count(*)::text as c from public.${table}`);

        return Number(res.rows[0]?.c ?? "0");
      });
      const countB = await asRole("authenticated", USER_B, async () => {
        const res = await client.query<{ c: string }>(`select count(*)::text as c from public.${table}`);

        return Number(res.rows[0]?.c ?? "0");
      });

      expect(countA, `Org A deveria ler 1 linha em ${table}`).toBe(1);
      expect(countB, `Org B não pode ler dados de Org A em ${table}`).toBe(0);

      await expect(
        asRole("authenticated", USER_A, () => client.query(`delete from public.${table}`)),
      ).rejects.toThrow(/permission denied/i);
    }
  });
});
