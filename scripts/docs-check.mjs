#!/usr/bin/env node
/**
 * Guarda o contexto dos agentes (D-177).
 *
 * O problema que este script existe para impedir já aconteceu: `HANDOFF.md`
 * chegou a 453 KB e `AGENTS.md` mandava carregar ~1,25 MB antes de começar
 * qualquer tarefa. Documento de estado vira diário sozinho, uma sessão de
 * cada vez, e ninguém percebe até o bootstrap ficar caro demais.
 *
 * O que ele NÃO faz: julgar conteúdo por tamanho apenas. Os limites são
 * budget, não verdade — por isso o erro diz o que fazer (arquivar), não
 * "corte texto".
 */
import { readFile, stat } from "node:fs/promises";

const KB = 1024;

/** Budget de bootstrap: o que todo agente lê antes de qualquer tarefa. */
const LIMITES = [
  { arquivo: "AGENTS.md", maxKb: 6, motivo: "é roteador, não manual" },
  { arquivo: "docs/HANDOFF.md", maxKb: 25, motivo: "é estado corrente; história vai para docs/archive/handoffs/" },
  { arquivo: "docs/ROADMAP.md", maxKb: 130, motivo: "é planejamento; narrativa longa vira D-xxx ou arquivo" },
];

/** Headings que o HANDOFF precisa ter para continuar respondendo o essencial. */
const HANDOFF_OBRIGATORIOS = [
  "## Estado",
  "## P0 ativos",
  "## Riscos ativos",
  "## Atos humanos pendentes",
  "## Próximos passos",
];

const problemas = [];

for (const limite of LIMITES) {
  const info = await stat(limite.arquivo).catch(() => null);

  if (info === null) {
    problemas.push(`${limite.arquivo}: não existe.`);
    continue;
  }

  const kb = info.size / KB;

  if (kb > limite.maxKb) {
    problemas.push(
      `${limite.arquivo}: ${kb.toFixed(1)} KB excede o budget de ${String(limite.maxKb)} KB (${limite.motivo}).`,
    );
  }
}

const handoff = await readFile("docs/HANDOFF.md", "utf8").catch(() => null);

if (handoff === null) {
  problemas.push("docs/HANDOFF.md: não pôde ser lido.");
} else {
  for (const heading of HANDOFF_OBRIGATORIOS) {
    if (!handoff.includes(heading)) {
      problemas.push(`docs/HANDOFF.md: falta a seção "${heading}".`);
    }
  }

  // Uma seção de "última etapa" por vez. Mais de uma é o sinal de que o
  // documento voltou a acumular sessões em vez de descrever o estado.
  const etapas = handoff.match(/^#{2,3} .*(Última etapa|Etapa anterior)/gmu) ?? [];

  if (etapas.length > 0) {
    problemas.push(
      `docs/HANDOFF.md: ${String(etapas.length)} seção(ões) de etapa histórica. O estado corrente não guarda etapas; arquive em docs/archive/handoffs/.`,
    );
  }

  if (!/\*\*HEAD conhecido\*\*/u.test(handoff)) {
    problemas.push('docs/HANDOFF.md: não declara o "HEAD conhecido".');
  }

  if (!/\*\*Atualizado em\*\*/u.test(handoff)) {
    problemas.push('docs/HANDOFF.md: não declara a data de atualização.');
  }
}

// O índice de decisões é derivado: se ficou para trás, o agente procura um
// D-xxx que o índice não conhece.
const [decisoes, indice] = await Promise.all([
  readFile("docs/DECISIONS.md", "utf8").catch(() => null),
  readFile("docs/DECISIONS_INDEX.md", "utf8").catch(() => null),
]);

if (decisoes !== null && indice !== null) {
  const idsFonte = new Set((decisoes.match(/^## (D-\d+)/gmu) ?? []).map((l) => l.slice(3)));
  const idsIndice = new Set((indice.match(/\*\*(D-\d+)\*\*/gu) ?? []).map((l) => l.replaceAll("*", "")));
  const faltando = [...idsFonte].filter((id) => !idsIndice.has(id));

  if (faltando.length > 0) {
    problemas.push(
      `docs/DECISIONS_INDEX.md: desatualizado — faltam ${faltando.slice(0, 5).join(", ")}${faltando.length > 5 ? "…" : ""}. Rode \`pnpm docs:index\`.`,
    );
  }
}

if (problemas.length > 0) {
  console.error("docs:check reprovou:\n");

  for (const problema of problemas) {
    console.error(`  - ${problema}`);
  }

  process.exit(1);
}

console.log("docs:check ok — contexto de bootstrap dentro do budget.");
