import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const script = fileURLToPath(new URL("./check-server-actions.mjs", import.meta.url));

function executarGuarda(t, codigo) {
  const fixture = mkdtempDisposableSync(join(tmpdir(), "sb-server-actions-"));
  t.onTestFinished(() => fixture.remove());
  mkdirSync(join(fixture.path, "app"));
  writeFileSync(join(fixture.path, "app", "actions.ts"), codigo, "utf8");
  const resultado = spawnSync(process.execPath, [script], { cwd: fixture.path, encoding: "utf8" });
  assert.ifError(resultado.error);
  return resultado;
}

test("detecta export inválido após comentário antes da diretiva de módulo", (t) => {
  const resultado = executarGuarda(t, '// Ações da tela\n"use server";\nexport const estados = [];\n');
  assert.equal(resultado.status, 1, resultado.stdout);
  assert.match(resultado.stderr, /actions\.ts:3\s+\(const estados\)/);
});

test("detecta export inválido após diretiva de módulo sem ponto e vírgula", (t) => {
  const resultado = executarGuarda(t, "'use server'\nexport const estados = [];\n");
  assert.equal(resultado.status, 1, resultado.stdout);
  assert.match(resultado.stderr, /actions\.ts:2\s+\(const estados\)/);
});

test("a diretiva dentro da função permite exportar valores do módulo", (t) => {
  const resultado = executarGuarda(t, 'export async function salvar() { "use server"; }\nexport const estados = [];\n');
  assert.equal(resultado.status, 0, resultado.stderr);
  assert.match(resultado.stdout, /0 módulos/);
});

test("permite função assíncrona exportada após uma diretiva de módulo", (t) => {
  const resultado = executarGuarda(t, '/* Ações da tela */\n"use server"\nexport async function salvar() {}\n');
  assert.equal(resultado.status, 0, resultado.stderr);
  assert.match(resultado.stdout, /1 módulos/);
});
