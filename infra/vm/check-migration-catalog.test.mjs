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

test("gera um plano estável e distingue alterações no catálogo e nos bytes do SQL", () => {
  const names = [filename(third), filename(first), filename(second)];
  const report = compareMigrationCatalog(names, `${first}\n${second}`, () => "select 1;");
  assert.match(report.plan.id, /^[0-9a-f]{64}$/u);
  assert.deepEqual(report.plan.files.map(({ name }) => name), [filename(third)]);
  assert.equal(
    compareMigrationCatalog([...names].reverse(), `${second}\r\n${first}\r\n`, () => "select 1;").plan.id,
    report.plan.id,
  );
  assert.notEqual(compareMigrationCatalog(names, `${first}\n${second}`, () => "select 2;").plan.id, report.plan.id);
  assert.notEqual(compareMigrationCatalog(names, `${first}\n${second}\n${third}`, () => "").plan.id, report.plan.id);
});

test("CLI diferencia bloqueio, entrada inválida e catálogo compatível", (t) => {
  const fixture = mkdtempDisposableSync(join(tmpdir(), "sb-migration-catalog-"));
  t.after(() => fixture.remove());
  for (const name of [filename(first), filename(second)]) writeFileSync(join(fixture.path, name), "");
  const script = fileURLToPath(new URL("./check-migration-catalog.mjs", import.meta.url));
  const run = (input, ...args) => spawnSync(process.execPath, [script, fixture.path, ...args], { input, encoding: "utf8" });
  const compatible = run(first);
  assert.equal(compatible.status, 0, compatible.stderr);
  assert.equal(JSON.parse(compatible.stdout).status, "pending");
  const blocked = run(second, "--plan");
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).status, "blocked");
  assert.equal(JSON.parse(blocked.stdout).plan, undefined);
  const invalid = run("not a catalog");
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stderr).status, "invalid_input");

  const planned = run(first, "--plan");
  assert.equal(planned.status, 0, planned.stderr);
  const { id } = JSON.parse(planned.stdout).plan;
  assert.equal(run(first, "--expect-plan", id).status, 0);
  writeFileSync(join(fixture.path, filename(second)), "select 42;");
  const changed = run(first, "--expect-plan", id);
  assert.equal(changed.status, 1, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).status, "plan_changed");
});

test("CLI vincula o plano ao HEAD e recusa SQL fora do checkout", (t) => {
  const fixture = mkdtempDisposableSync(join(tmpdir(), "sb-migration-commit-"));
  t.after(() => fixture.remove());
  const git = (...args) => {
    const result = spawnSync("git", ["-C", fixture.path, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet", "--template=");
  writeFileSync(join(fixture.path, ".gitignore"), "/20261119180001_sentinel.sql\n");
  for (const name of [filename(first), filename(second)]) writeFileSync(join(fixture.path, name), "select 1;\n");
  git("add", ".");
  const commit = (...args) => git("-c", "user.name=Sentinel Fixture", "-c", "user.email=sentinel@example.test",
    "-c", "commit.gpgsign=false", "commit", "--quiet", ...args);
  commit("-m", "base");
  const script = fileURLToPath(new URL("./check-migration-catalog.mjs", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, fixture.path, ...args], { input: first, encoding: "utf8" });

  const planned = run("--plan", "--bind-head");
  assert.equal(planned.status, 0, planned.stderr);
  const { id, revision } = JSON.parse(planned.stdout).plan;
  assert.equal(revision, git("rev-parse", "HEAD"));
  assert.equal(run("--expect-plan", id, "--bind-head").status, 0);
  assert.equal(run("--expect-plan", id).status, 1);
  assert.equal(run("--bind-head").status, 2);

  commit("--allow-empty", "-m", "outro commit");
  const changed = run("--expect-plan", id, "--bind-head");
  assert.equal(changed.status, 1, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).status, "plan_changed");

  const pending = join(fixture.path, filename(second));
  writeFileSync(pending, "select 2;\n");
  const modified = run("--plan", "--bind-head");
  assert.equal(modified.status, 2);
  assert.match(modified.stderr, /migrations SQL fora do commit/);
  git("add", filename(second));
  const staged = run("--plan", "--bind-head");
  assert.equal(staged.status, 2);
  assert.match(staged.stderr, /migrations SQL fora do commit/);

  git("restore", "--source=HEAD", "--staged", "--worktree", filename(second));
  writeFileSync(join(fixture.path, filename(third)), "select 3;\n");
  const ignored = run("--plan", "--bind-head");
  assert.equal(ignored.status, 2);
  assert.match(ignored.stderr, /migrations SQL fora do commit/);
});
