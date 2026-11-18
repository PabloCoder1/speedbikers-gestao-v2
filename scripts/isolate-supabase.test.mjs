import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("uma porta ocupada faz escolher outro bloco sem tocar no serviço existente", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sb-isolation-"));
  const path = join(dir, "config.toml");
  const server = createServer();
  let owned = false;
  try {
    await new Promise((ok, fail) => {
      server.once("error", fail);
      server.listen(60022, "0.0.0.0", ok);
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
    assert.doesNotMatch(config, /port = (?:54322|60022)\b/u);
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
