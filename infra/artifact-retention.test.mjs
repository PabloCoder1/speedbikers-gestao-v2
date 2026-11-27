import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "artifact-retention.sh");

function bashExecutable() {
  if (process.platform === "win32") {
    return "C:\\Program Files\\Git\\bin\\bash.exe";
  }

  return "bash";
}

function makeFakeGcloudDir(existingBucketJson) {
  const dir = mkdtempSync(join(tmpdir(), "sb-ar-retention-"));
  const logFile = join(dir, "gcloud.log");
  const capturedLifecycle = join(dir, "captured-lifecycle.json");
  const bucketJsonPath = join(dir, "bucket.json");

  writeFileSync(bucketJsonPath, JSON.stringify(existingBucketJson), "utf8");

  const fakeScript = `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${logFile.replace(/\\/g, "/")}"
if [[ "$1 $2 $3" == "storage buckets describe" ]]; then
  cat "${bucketJsonPath.replace(/\\/g, "/")}"
  exit 0
fi
if [[ "$1 $2 $3" == "storage buckets update" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == --lifecycle-file=* ]]; then
      cp "\${arg#--lifecycle-file=}" "${capturedLifecycle.replace(/\\/g, "/")}"
    fi
  done
  exit 0
fi
exit 0
`;
  const gcloudPath = join(dir, "gcloud");

  writeFileSync(gcloudPath, fakeScript, { encoding: "utf8", mode: 0o755 });

  return { dir, logFile, capturedLifecycle };
}

test("prévia (padrão e --dry-run) não chama nenhum comando de escrita", () => {
  const { dir, logFile } = makeFakeGcloudDir({ lifecycle_config: { rule: [] } });

  try {
    for (const extraArgs of [[], ["--dry-run"]]) {
      writeFileSync(logFile, "", "utf8");
      execFileSync(
        bashExecutable(),
        [SCRIPT, "--project", "speedbikers-prod", "--cloudbuild-lifecycle", ...extraArgs],
        {
          env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` },
          encoding: "utf8",
        },
      );

      const calls = readFileSync(logFile, "utf8");

      assert.match(calls, /artifacts repositories describe/);
      assert.match(calls, /storage buckets describe/);
      assert.doesNotMatch(calls, /set-cleanup-policies/);
      assert.doesNotMatch(calls, /storage buckets update/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--apply --cloudbuild-lifecycle preserva regras existentes do bucket e não duplica a regra de 30 dias", () => {
  const existingRule = { action: { type: "SetStorageClass", storageClass: "COLDLINE" }, condition: { age: 90 } };
  const { dir, logFile, capturedLifecycle } = makeFakeGcloudDir({
    lifecycle_config: { rule: [existingRule] },
  });

  try {
    execFileSync(
      bashExecutable(),
      [SCRIPT, "--project", "speedbikers-prod", "--apply", "--cloudbuild-lifecycle"],
      {
        env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` },
        encoding: "utf8",
      },
    );

    const calls = readFileSync(logFile, "utf8");

    assert.match(calls, /artifacts repositories set-cleanup-policies/);
    assert.match(calls, /--no-dry-run/);
    assert.match(calls, /storage buckets update/);

    const merged = JSON.parse(readFileSync(capturedLifecycle, "utf8"));

    assert.deepEqual(merged.lifecycle.rule, [
      existingRule,
      { action: { type: "Delete" }, condition: { age: 30 } },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
