import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { eligibleBlockBases } from "./isolate-supabase.mjs";

test("evita portas efêmeras e o intervalo de publicações do Docker", () => {
  const ports = [54320, 54321, 54322];
  const ephemeral = [{ first: 32768, last: 60999 }];
  assert.equal(eligibleBlockBases(ports, ephemeral)[0], 61000);
  assert.equal(eligibleBlockBases(ports, [...ephemeral, { first: 61021, last: 61121 }])[0], 61200);
  assert.equal(eligibleBlockBases(ports, [{ first: 60000, last: 65535 }])[0], 20000);
});

test("uma porta ocupada faz escolher outro bloco sem tocar no serviço existente", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sb-isolation-"));
  const path = join(dir, "config.toml");
  const server = createServer();
  let owned = false;
  try {
    await new Promise((ok, fail) => {
      server.once("error", fail);
      server.listen(61022, "0.0.0.0", ok);
    });
    owned = true;
  } catch (error) {
    // Uma stack local já pode ocupar o bloco; ela também deve ser preservada.
    if (error.code !== "EADDRINUSE") throw error;
  }
  try {
    await writeFile(path, 'project_id = "original"\n[api]\nport = 54321\n[db]\nport = 54322\nshadow_port = 54320\n');
    const run = spawnSync(process.execPath, ["scripts/isolate-supabase.mjs", path], {
      env: { ...process.env, SUPABASE_TEST_ID: "sb-test-isolation" }, encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const config = await readFile(path, "utf8");
    assert.match(config, /project_id = "sb-test-isolation"/u);
    assert.doesNotMatch(config, /port = (?:54322|61022)\b/u);
    // Nenhuma porta do bloco escolhido cai na faixa temporária do Linux.
    for (const [, port] of config.matchAll(/port = (\d+)/gu)) assert.ok(Number(port) > 60999, port);
    if (owned) assert.equal(server.listening, true);
    const repeat = spawnSync(process.execPath, ["scripts/isolate-supabase.mjs", path], {
      env: { ...process.env, SUPABASE_TEST_ID: "sb-test-isolation" }, encoding: "utf8",
    });
    assert.notEqual(repeat.status, 0);
    assert.equal(await readFile(path, "utf8"), config);
  } finally {
    if (owned) await new Promise((done) => server.close(done));
    await rm(dir, { recursive: true });
  }
});
