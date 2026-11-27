import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { compareMigrationCatalog } from "./check-migration-catalog.mjs";

/**
 * Confere uma base descartável e as adições do candidato. As versões antigas
 * ficam identificadas para o ensaio local. A regra de publicação continua no
 * check-migration-catalog.mjs.
 */
export function planLocalUpgrade(base, candidate, catalogText) {
  const verifiedBase = compareMigrationCatalog([...base.migrations.keys()], catalogText);

  if (verifiedBase.status !== "match") {
    throw new Error("O catálogo local deve corresponder exatamente às migrations da base.");
  }

  for (const [name, blob] of base.migrations) {
    if (candidate.migrations.get(name) !== blob) {
      throw new Error(`Migration da base removida, renomeada ou alterada no candidato: ${name}`);
    }
  }

  const delta = compareMigrationCatalog([...candidate.migrations.keys()], catalogText);
  const pending = [...delta.pendingBeforeLatest, ...delta.pendingAfterLatest]
    .map((name) => ({ name, gitBlob: candidate.migrations.get(name) }));

  return {
    baseCommit: base.commit,
    candidateCommit: candidate.commit,
    baseCount: verifiedBase.appliedCount,
    latestBaseVersion: verifiedBase.latestApplied,
    expectedCount: delta.localCount,
    pending,
    pendingBeforeLatest: delta.pendingBeforeLatest,
  };
}

function readMigrationTree(ref) {
  const commit = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], {
    encoding: "utf8",
  }).trim();
  const prefix = "supabase/migrations/";
  const entries = execFileSync("git", ["ls-tree", "-rz", "--full-tree", commit, "--", prefix], { encoding: "utf8" });
  const migrations = new Map();

  for (const entry of entries.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t");
    const [mode, type, blob] = entry.slice(0, separator).split(" ");
    const name = entry.slice(separator + 1).slice(prefix.length);

    if (!name.endsWith(".sql")) continue;
    if (name.includes("/") || type !== "blob" || !["100644", "100755"].includes(mode)) {
      throw new Error(`SQL fora do formato de arquivo regular esperado: ${name}`);
    }

    migrations.set(name, blob);
  }

  return { commit, migrations };
}

if (import.meta.main) {
  try {
    const [base, candidate, ...remaining] = process.argv.slice(2);
    if (!base || !candidate || remaining.length || process.stdin.isTTY) {
      throw new Error("Informe dois commits (base e candidato) e envie o catálogo local pela entrada padrão.");
    }

    const report = planLocalUpgrade(readMigrationTree(base), readMigrationTree(candidate), readFileSync(0, "utf8"));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
