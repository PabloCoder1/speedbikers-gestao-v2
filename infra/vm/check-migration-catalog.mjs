import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const MIGRATIONS = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

function validVersion(version) {
  if (!/^\d{14}$/u.test(version) || version.startsWith("0000")) return false;
  const iso = version.replace(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/u,
    "$1-$2-$3T$4:$5:$6.000Z",
  );
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && date.toISOString() === iso;
}

function committedRevision(directory) {
  const git = (...args) => execFileSync("git", ["--no-optional-locks", "-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  const revision = git("rev-parse", "--verify", "HEAD");
  const modified = git("diff", "--name-only", "HEAD", "--", "*.sql");
  const untracked = git("ls-files", "--others", "--", "*.sql");
  if (modified || untracked) {
    throw new Error("Há migrations SQL fora do commit atual.");
  }
  return revision;
}

export function compareMigrationCatalog(fileNames, catalogText, readSql, revision) {
  const local = new Map();
  for (const name of fileNames.filter((name) => name.endsWith(".sql")).sort()) {
    const match = /^(\d{14})_.+\.sql$/u.exec(name);
    const version = match?.[1];
    if (!version || !validVersion(version)) throw new Error(`Nome de migration inválido: ${name}`);
    if (local.has(version)) throw new Error(`Versão duplicada no Git: ${version}`);
    local.set(version, name);
  }
  if (local.size === 0) throw new Error("Nenhuma migration SQL encontrada.");

  const catalog = catalogText.trim();
  if (catalog === "") throw new Error("Catálogo aplicado vazio.");

  const applied = new Set();
  for (const [index, line] of catalog.split(/\r?\n/u).entries()) {
    const version = line.trim();
    if (!validVersion(version)) throw new Error(`Versão inválida no catálogo, linha ${index + 1}.`);
    if (applied.has(version)) throw new Error(`Versão duplicada no catálogo: ${version}`);
    applied.add(version);
  }

  const latestApplied = [...applied].sort().at(-1);
  const appliedNotInGit = [...applied].filter((version) => !local.has(version)).sort();
  const pendingAfterLatest = [];
  const pendingBeforeLatest = [];
  for (const [version, name] of local) {
    if (applied.has(version)) continue;
    if (version > latestApplied) pendingAfterLatest.push(name);
    else pendingBeforeLatest.push(name);
  }

  const status = appliedNotInGit.length || pendingBeforeLatest.length
    ? "blocked"
    : pendingAfterLatest.length ? "pending" : "match";

  const report = {
    status,
    localCount: local.size,
    appliedCount: applied.size,
    latestApplied,
    pendingAfterLatest,
    pendingBeforeLatest,
    appliedNotInGit,
  };
  if (readSql && status !== "blocked") {
    const catalogSha256 = sha256([...applied].sort().join("\n"));
    const files = pendingAfterLatest.map((name) => ({ name, sha256: sha256(readSql(name)) }));
    const manifest = { catalogSha256, files, ...(revision === undefined ? {} : { revision }) };
    report.plan = { ...manifest, id: sha256(JSON.stringify(manifest)) };
  }
  return report;
}

if (import.meta.main) {
  try {
    if (process.stdin.isTTY) throw new Error("Envie o catálogo de versões pela entrada padrão.");
    const { values, positionals } = parseArgs({
      options: {
        plan: { type: "boolean" },
        "expect-plan": { type: "string" },
        "bind-head": { type: "boolean" },
      },
      allowPositionals: true,
    });
    if (positionals.length > 1) throw new Error("Informe no máximo um diretório de migrations.");
    const expected = values["expect-plan"];
    if (expected !== undefined && !/^[0-9a-f]{64}$/u.test(expected)) {
      throw new Error("ID do plano esperado inválido.");
    }
    if (values["bind-head"] && !values.plan && expected === undefined) {
      throw new Error("--bind-head exige --plan ou --expect-plan.");
    }
    const directory = positionals[0] ?? MIGRATIONS;
    const revision = values["bind-head"] ? committedRevision(directory) : undefined;
    const entries = readdirSync(directory, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const readSql = (values.plan || expected !== undefined) ? (name) => readFileSync(join(directory, name)) : undefined;
    const report = compareMigrationCatalog(files, readFileSync(0, "utf8"), readSql, revision);
    if (report.plan && expected !== undefined && report.plan.id !== expected) report.status = "plan_changed";
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "blocked" || report.status === "plan_changed") process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: "invalid_input", error: error.message }));
    process.exitCode = 2;
  }
}
