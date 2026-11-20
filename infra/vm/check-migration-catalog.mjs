import { readdirSync, readFileSync } from "node:fs";

const MIGRATIONS = new URL("../../supabase/migrations/", import.meta.url);

function validVersion(version) {
  if (!/^\d{14}$/u.test(version) || version.startsWith("0000")) return false;
  const iso = version.replace(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/u,
    "$1-$2-$3T$4:$5:$6.000Z",
  );
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && date.toISOString() === iso;
}

export function compareMigrationCatalog(fileNames, catalogText) {
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

  return {
    status,
    localCount: local.size,
    appliedCount: applied.size,
    latestApplied,
    pendingAfterLatest,
    pendingBeforeLatest,
    appliedNotInGit,
  };
}

if (import.meta.main) {
  try {
    if (process.stdin.isTTY) throw new Error("Envie o catálogo de versões pela entrada padrão.");
    const entries = readdirSync(process.argv[2] ?? MIGRATIONS, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const report = compareMigrationCatalog(files, readFileSync(0, "utf8"));
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "blocked") process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: "invalid_input", error: error.message }));
    process.exitCode = 2;
  }
}
