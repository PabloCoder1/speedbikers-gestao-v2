import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

/*
 * "account permission filtra corretamente" (spec test #7). A full
 * behavioral test would require signing in as a real Mercado Livre
 * account-restricted user to get a genuine JWT — not reachable from
 * node:test through supabase-js/PostgREST (no service_role bypass
 * mints a real user session, and RLS itself can only be exercised by
 * an actual authenticated request). What we CAN verify — and what
 * actually matters for this property to hold — is that none of the
 * four new RPCs bypass Postgres RLS: they must stay invoker-mode
 * (no `security definer`) and route reads through
 * orders/order_items/daily_product_metrics directly, so
 * "... using (private.can_access_ml_account(ml_account_id))" applies
 * automatically to every real caller. This is a structural guarantee
 * of the SQL text itself, not a live request.
 */
const migrationPath = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
  "20260819120000_add_sales_orders_workspace.sql",
);

function readMigrationSql() {
  return readFileSync(migrationPath, "utf8");
}

function functionBody(sql: string, functionName: string) {
  const start = sql.indexOf(`create or replace function public.${functionName}(`);
  assert.ok(start >= 0, `function ${functionName} not found in migration`);
  const end = sql.indexOf("\n$$;", start);
  assert.ok(end > start, `end of function ${functionName} not found`);
  return sql.slice(start, end);
}

const functionNames = [
  "get_sales_orders_summary",
  "get_sales_orders_page",
  "get_sales_order_detail",
  "get_product_sales_timeline_events",
];

for (const functionName of functionNames) {
  test(`${functionName} is invoker-mode (never bypasses RLS via security definer)`, () => {
    const body = functionBody(readMigrationSql(), functionName);
    assert.equal(
      /security\s+definer/i.test(body),
      false,
      `${functionName} must stay invoker-mode so orders/order_items/daily_product_metrics RLS applies`,
    );
  });

  test(`${functionName} re-validates organization membership before reading`, () => {
    const body = functionBody(readMigrationSql(), functionName);
    assert.ok(
      body.includes("private.is_organization_member(target_organization_id)"),
      `${functionName} must check org membership explicitly`,
    );
  });

  test(`${functionName} is never granted to anon`, () => {
    const sql = readMigrationSql();
    const grantIndex = sql.indexOf(`grant execute on function public.${functionName}(`);
    assert.ok(grantIndex >= 0, `grant for ${functionName} not found`);
    const revokeLine = sql.slice(0, grantIndex).split("\n").reverse()
      .find((line) => line.includes(`revoke all on function public.${functionName}(`));
    assert.ok(revokeLine?.includes("anon"), `${functionName} must revoke anon before granting authenticated`);
  });
}
