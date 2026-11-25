import assert from "node:assert/strict";
import test from "node:test";

import { planLocalUpgrade } from "./plan-local-upgrade.mjs";

const previousFile = "20261123180000_base.sql";
const currentFile = "20261124140000_base.sql";
const ancientFile = "20261117182600_replay.sql";
const laterFile = "20261125103000_pending.sql";
const applied = "20261123180000\n20261124140000\n";

const base = {
  commit: "base-commit",
  migrations: new Map([[previousFile, "previous-blob"], [currentFile, "current-blob"]]),
};

test("vincula o catálogo, a base, o candidato e os dois tipos de pendência", () => {
  const candidate = {
    commit: "candidate-commit",
    migrations: new Map([...base.migrations, [laterFile, "later-blob"], [ancientFile, "ancient-blob"]]),
  };

  assert.deepEqual(planLocalUpgrade(base, candidate, applied), {
    baseCommit: "base-commit",
    candidateCommit: "candidate-commit",
    baseCount: 2,
    latestBaseVersion: "20261124140000",
    expectedCount: 4,
    pending: [{ name: ancientFile, gitBlob: "ancient-blob" }, { name: laterFile, gitBlob: "later-blob" }],
    pendingBeforeLatest: [ancientFile],
  });
});

test("recusa base parcial ou catálogo com versão extra", () => {
  assert.throws(() => planLocalUpgrade(base, base, "20261123180000"), /catálogo local/);
  assert.throws(() => planLocalUpgrade(base, base, applied + "20261125103000"), /catálogo local/);
});

test("recusa alterar ou renomear arquivo já aplicado mesmo com a mesma versão", () => {
  for (const migrations of [
    new Map([...base.migrations, [currentFile, "changed-blob"]]),
    new Map([[previousFile, "previous-blob"], ["20261124140000_renamed.sql", "current-blob"]]),
  ]) {
    assert.throws(() => planLocalUpgrade(base, { commit: "candidate", migrations }, applied), /Migration da base/);
  }
});

test("recusa duplicar uma versão nova", () => {
  const migrations = new Map([...base.migrations, [laterFile, "later-blob"], ["20261125103000_duplicate.sql", "x"]]);

  assert.throws(() => planLocalUpgrade(base, { commit: "candidate", migrations }, applied), /Versão duplicada/);
});
