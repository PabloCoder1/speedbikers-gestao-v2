import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";

export function eligibleBlockBases(ports, excluded) {
  const blocks = [
    ...Array.from({ length: 50 }, (_, index) => 60000 + index * 100),
    ...Array.from({ length: 400 }, (_, index) => 20000 + index * 100),
  ];
  return blocks.filter((base) => {
    const candidates = ports.map((port) => base + port - 54300);
    return candidates.every((port) => excluded.every(({ first, last }) => port < first || port > last));
  });
}

async function isolateStack() {
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

  // O daemon Docker pode publicar portas fora da rede que o Node enxerga.
  const published = execFileSync("docker", ["ps", "--format", "{{.Ports}}"], { encoding: "utf8" });
  const excluded = Array.from(
    published.matchAll(/:(\d+)(?:-(\d+))?->/gu),
    ([, first, last = first]) => ({ first: Number(first), last: Number(last) }),
  );

  // Evita portas escolhidas pelo kernel para conexões de saída entre a
  // liberação dos sockets de teste e o bind do Docker no runner Linux.
  if (process.platform === "linux") {
    const range = await readFile("/proc/sys/net/ipv4/ip_local_port_range", "utf8");
    const [first, last] = range.trim().split(/\s+/u).map(Number);
    excluded.push({ first, last });
  }

  // Mantém o bloco reservado até testar todas as portas. A stack sobe logo após
  // a liberação; uma disputa posterior continua falhando alto no Docker.
  let selected;
  for (const base of eligibleBlockBases(ports, excluded)) {
    const candidates = ports.map((port) => base + port - 54300);

    const servers = [];
    try {
      for (const port of candidates) {
        const server = createServer();
        servers.push(server);
        await new Promise((ok, fail) => {
          server.once("error", fail);
          server.listen(port, "0.0.0.0", ok);
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
}

if (import.meta.main) await isolateStack();
