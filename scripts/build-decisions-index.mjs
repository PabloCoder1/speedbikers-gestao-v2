#!/usr/bin/env node
/**
 * Gera `docs/DECISIONS_INDEX.md` a partir de `docs/DECISIONS.md` (D-177).
 *
 * O arquivo de decisões passou de 600 KB. Carregá-lo inteiro no início de
 * cada sessão custa mais contexto do que o repositório inteiro de código —
 * e a maior parte é irrelevante para a tarefa da vez.
 *
 * O índice é DERIVADO, nunca editado à mão: o título e o id continuam
 * morando em `DECISIONS.md`, que segue sendo a fonte. Isto aqui é só um
 * mapa para o agente achar `D-xxx` sem ler tudo.
 *
 * Uso: `pnpm docs:index` (ou via `pnpm docs:check`, que valida se está
 * atualizado).
 */
import { readFile, writeFile } from "node:fs/promises";

const FONTE = "docs/DECISIONS.md";
const DESTINO = "docs/DECISIONS_INDEX.md";

/** `## D-123 - Título da decisão` → { id, titulo }. */
const CABECALHO = /^## (D-\d+)\s*[-—]\s*(.+)$/;

/**
 * Domínio inferido de palavras do título. É uma DICA de busca, não uma
 * taxonomia — por isso "outros" é um destino legítimo e não um defeito.
 */
const DOMINIOS = [
  { nome: "banco/rls", termos: ["rls", "policy", "policies", "migration", "índice", "indice", "postgres", "sql", "grant", "privilégio", "privilegio"] },
  { nome: "mercado-livre", termos: ["mercado livre", "ml", "webhook", "relist", "anúncio", "anuncio", "visitas", "429", "rate limit", "oauth"] },
  { nome: "estoque", termos: ["estoque", "ledger", "movimenta", "full", "cobertura", "reposi", "kit"] },
  { nome: "vendas/métricas", termos: ["venda", "métrica", "metrica", "receita", "margem", "conversão", "conversao", "abc", "pedidos"] },
  { nome: "worker/infra", termos: ["worker", "cloud", "deploy", "job", "fila", "scheduler", "task", "ci"] },
  { nome: "interface", termos: ["tela", "dashboard", "página", "pagina", "ui", "aba", "filtro"] },
  { nome: "atendimento", termos: ["atendimento", "sac", "pergunta", "mensagem", "claim", "copiloto", "ia"] },
  { nome: "processo/docs", termos: ["documenta", "handoff", "roadmap", "processo", "contexto", "agente"] },
];

function inferirDominio(titulo) {
  const alvo = titulo.toLowerCase();
  const achado = DOMINIOS.find((d) => d.termos.some((t) => alvo.includes(t)));

  return achado?.nome ?? "outros";
}

const conteudo = await readFile(FONTE, "utf8");
const linhas = conteudo.split("\n");

const decisoes = [];

for (const linha of linhas) {
  const match = CABECALHO.exec(linha);

  if (match !== null) {
    const [, id, titulo] = match;
    decisoes.push({ id, titulo: titulo.trim(), dominio: inferirDominio(titulo) });
  }
}

decisoes.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));

const porDominio = new Map();

for (const d of decisoes) {
  const lista = porDominio.get(d.dominio) ?? [];
  lista.push(d);
  porDominio.set(d.dominio, lista);
}

const linhasSaida = [
  "# Índice de decisões — Speed Bikers Gestão V3",
  "",
  "> **Arquivo gerado.** Não edite à mão: rode `pnpm docs:index`.",
  "> A fonte é `docs/DECISIONS.md`, que continua sendo o documento normativo.",
  "",
  "## Como usar",
  "",
  "Não leia `DECISIONS.md` inteiro (são mais de 600 KB). Ache aqui o `D-xxx`",
  "relevante para a tarefa e leia **apenas** aquela seção, por exemplo:",
  "",
  "```bash",
  'grep -n "^## D-171" -A 40 docs/DECISIONS.md',
  "```",
  "",
  `Decisões registradas: **${String(decisoes.length)}** (D-001 a ${decisoes.at(-1)?.id ?? "—"}).`,
  "",
  "## Por domínio",
  "",
];

for (const [dominio, lista] of [...porDominio.entries()].sort()) {
  linhasSaida.push(`### ${dominio} (${String(lista.length)})`, "");

  for (const d of lista) {
    linhasSaida.push(`- **${d.id}** — ${d.titulo}`);
  }

  linhasSaida.push("");
}

await writeFile(DESTINO, `${linhasSaida.join("\n")}\n`, "utf8");

console.log(`${DESTINO}: ${String(decisoes.length)} decisões indexadas em ${String(porDominio.size)} domínios.`);
