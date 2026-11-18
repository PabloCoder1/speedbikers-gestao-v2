import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";

// Apenas a stack de testes desta worktree. Não para nem remove containers
// alheios quando a porta padrão já pertence a outro serviço.
const configPath = resolve(process.argv[2] ?? "supabase/config.toml");
const id = process.env.SUPABASE_TEST_ID;
if (!id || !/^[a-z0-9-]{1,80}$/u.test(id)) {
  throw new Error("Informe SUPABASE_TEST_ID (letras minúsculas, números e hífen).");
}
const config = await readFile(configPath, "utf8");
const ports = [...new Set([...config.matchAll(/\b543\d{2}\b/gu)].map(([port]) => Number(port)))];
if (!ports.includes(54321) || !ports.includes(54322)) {
  throw new Error("Config deve partir das portas padrão 543xx; não reutilize uma stack já isolada.");
}

// Mantém o bloco reservado até testar todas as portas. A stack sobe logo após
// a liberação; uma disputa posterior continua falhando alto no Docker.
let selected;
for (let base = 60000; base < 65000; base += 100) {
  const servers = [];
  try {
    for (const port of ports) {
      const server = createServer();
      servers.push(server);
      await new Promise((ok, fail) => {
        server.once("error", fail);
        server.listen(base + port - 54300, "0.0.0.0", ok);
      });
    }
    selected = base;
  } catch (error) {
    if (!["EADDRINUSE", "EACCES"].includes(error.code)) throw error;
  } finally {
    await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  }
  if (selected !== undefined) break;
}
if (selected === undefined) throw new Error("Nenhum bloco de portas livre para o Supabase de testes.");

const isolated = config
  .replace(/^project_id = ".*"$/mu, `project_id = "${id}"`)
  .replace(/\b543\d{2}\b/gu, (port) => String(selected + Number(port) - 54300));
await writeFile(configPath, isolated);
console.log(`Stack ${id}: API ${selected + 21}, Postgres ${selected + 22} (${configPath}).`);
