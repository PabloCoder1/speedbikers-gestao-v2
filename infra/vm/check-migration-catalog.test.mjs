import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compareMigrationCatalog } from "./check-migration-catalog.mjs";

const first = "20261119120000";
const second = "20261119180000";
const third = "20261119180001";
const filename = (version) => `${version}_sentinel.sql`;

test("aceita catálogo igual e separa apenas pendências posteriores", () => {
  const names = [filename(second), filename(first), "README.md"];
  assert.equal(compareMigrationCatalog(names, `${first}\r\n${second}\r\n`).status, "match");
  assert.deepEqual(compareMigrationCatalog(names, first), {
    status: "pending", localCount: 2, appliedCount: 1, latestApplied: first,
    pendingAfterLatest: [filename(second)], pendingBeforeLatest: [], appliedNotInGit: [],
  });
});

test("bloqueia lacuna antiga e versão aplicada ausente do Git", () => {
  assert.deepEqual(compareMigrationCatalog([filename(first), filename(third)], second), {
    status: "blocked", localCount: 2, appliedCount: 1, latestApplied: second,
    pendingAfterLatest: [filename(third)], pendingBeforeLatest: [filename(first)], appliedNotInGit: [second],
  });
});

test("recusa datas impossíveis, versão duplicada e catálogo vazio", () => {
  const names = [filename(first)];
  assert.throws(() => compareMigrationCatalog(names, ""), /vazio/);
  assert.throws(() => compareMigrationCatalog(names, "20260230000000"), /inválida no catálogo/);
  assert.throws(() => compareMigrationCatalog(names, "00000101000000"), /inválida no catálogo/);
  assert.throws(() => compareMigrationCatalog(names, `${first}\n${first}`), /duplicada no catálogo/);
  assert.throws(() => compareMigrationCatalog([filename(first), `${first}_outra.sql`], first), /duplicada no Git/);
  assert.throws(() => compareMigrationCatalog([filename("20261119240000")], first), /Nome de migration inválido/);
  assert.throws(() => compareMigrationCatalog(["README.md"], first), /Nenhuma migration/);
});

test("CLI diferencia bloqueio, entrada inválida e catálogo compatível", (t) => {
  const fixture = mkdtempDisposableSync(join(tmpdir(), "sb-migration-catalog-"));
  t.after(() => fixture.remove());
  for (const name of [filename(first), filename(second)]) writeFileSync(join(fixture.path, name), "");
  const script = fileURLToPath(new URL("./check-migration-catalog.mjs", import.meta.url));
  const run = (input) => spawnSync(process.execPath, [script, fixture.path], { input, encoding: "utf8" });
  const compatible = run(first);
  assert.equal(compatible.status, 0, compatible.stderr);
  assert.equal(JSON.parse(compatible.stdout).status, "pending");
  const blocked = run(second);
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).status, "blocked");
  const invalid = run("not a catalog");
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stderr).status, "invalid_input");
});
