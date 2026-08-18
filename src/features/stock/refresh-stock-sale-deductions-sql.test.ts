import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

/*
 * Structural check against the migration SQL itself — the same
 * "no local Postgres" constraint that applies to every SQL-side
 * behavior in this repo. Mirrors the style of the webhook
 * no-API-call check in order-refresh-resource.test.ts: read the
 * source, assert the dangerous pattern is structurally absent.
 */
function readRefreshMigration() {
  const filePath = path.join(
    process.cwd(),
    "supabase/migrations/20260818163000_serialize_stock_sale_deductions_refresh.sql",
  );
  const raw = readFileSync(filePath, "utf8");

  // The header comment block describes the change in prose and
  // mentions "refresh materialized view" as quoted text — strip `--`
  // line comments so structural checks only see real SQL statements.
  return raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

test("usa pg_try_advisory_xact_lock (não bloqueante) antes de qualquer refresh", () => {
  const sql = readRefreshMigration();
  const lockIndex = sql.indexOf("pg_try_advisory_xact_lock");
  const firstRefreshIndex = sql.indexOf("refresh materialized view");

  assert.ok(lockIndex >= 0, "deveria usar pg_try_advisory_xact_lock");
  assert.ok(
    lockIndex < firstRefreshIndex,
    "o lock precisa ser tentado antes do primeiro refresh",
  );
});

test("cenário 8 — retorna already_running sem esperar o lock", () => {
  const sql = readRefreshMigration();
  assert.ok(sql.includes("already_running"));
  assert.ok(
    !/pg_advisory_xact_lock\(/.test(sql),
    "não deve usar a variante bloqueante pg_advisory_xact_lock",
  );
});

test("cenário 9 — falha do refresh concorrente nunca cai para um refresh bloqueante", () => {
  const sql = readRefreshMigration();

  // O corpo inteiro só pode conter UMA chamada de refresh, e ela
  // precisa ser CONCURRENTLY — não pode existir um segundo
  // "refresh materialized view" sem CONCURRENTLY (o fallback
  // bloqueante que este hotfix remove).
  const refreshCalls = sql.match(/refresh materialized view\b[^;]*/gi) ?? [];
  assert.equal(refreshCalls.length, 1, "deve haver exatamente uma chamada de refresh");
  assert.ok(/refresh materialized view concurrently/i.test(refreshCalls[0]));

  assert.ok(sql.includes("concurrent_refresh_failed"));
});
