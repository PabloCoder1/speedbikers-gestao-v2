/**
 * Procura o DIA tirado de um instante sem o fuso de São Paulo (D-656).
 *
 * **Por que existe.** O dia de negócio da V3 é o de São Paulo (D-050), e um
 * instante (`timestamptz`, `new Date()`) só vira dia passando pelo fuso. Três
 * formas erram sem nenhum aviso -- o build, o typecheck e o e2e passam, porque
 * o e2e roda de dia:
 *
 *   - `toISOString().slice(0, 10)` (ou `.split("T")[0]`): o dia em UTC. Depois
 *     das 21h de Brasília, "hoje" já é amanhã, e a janela anda um dia. Era o
 *     defeito de seis telas em 18/09 (`lib/business-window.ts`) e ainda estava
 *     na `/vinculacoes` e na Inspeção Rápida;
 *   - `<instante>.slice(0, 10)`: o começo do texto ISO, que é o dia em UTC. Era
 *     o "último movimento" da `/estoque` e as datas da `/integracoes`;
 *   - `formatBusinessDate(<instante>)`: ela só aceita `AAAA-MM-DD` e devolve
 *     "—" para um instante. Era a idade do cartão da `/acoes` e a "Alteração
 *     em" do anúncio (D-648).
 *
 * O certo: `formatDay` ou `formatDateTime` para mostrar, `toSalesMetricDate`,
 * `hojeSaoPaulo` ou `lastBusinessDays` para montar janela.
 *
 * **O que não reprova:**
 *
 *   - a previsão de entrega do pedido de compra (`expected_at`/`expectedAt`). O
 *     dia escolhido é gravado como meia-noite UTC, e o começo do texto É o dia;
 *   - os arquivos de `ISENTOS`, cada um com o motivo;
 *   - comentários.
 *
 * A heurística olha o NOME: um instante se chama `*_at`/`*At` no projeto. Um
 * instante com outro nome escapa, e quem pega é a revisão.
 *
 * **A lista de pendências só diminui.** Arquivo novo com o padrão reprova;
 * arquivo de `PENDENTES` que ficou limpo também reprova, para sair dela.
 *
 * Ele se prova na carga: se a detecção parar de achar os exemplos abaixo, falha
 * alto em vez de ficar verde sem detectar nada.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const RAIZES = ["app", "components", "lib"];

/** Conta de calendário sobre uma data montada em UTC de propósito: o dia já é o de negócio. */
const ISENTOS = new Map([
  ["app/(app)/compras/novo/rascunho.ts", "`somarDias` soma dias a uma data de negócio montada com `Date.UTC`"],
  ["lib/metas-imposto.ts", "valida o texto `AAAA-MM-DD` contra a data UTC montada do próprio texto"],
]);

/** Telas que ainda usam o dia em UTC, com o motivo. Sai daqui quem corrigir; ninguém entra. */
const PENDENTES = new Map([
  ["app/(app)/acoes/page.tsx", "a idade do cartão; corrigida na D-648 (#321), que espera a migration do C-83 -- sai daqui no merge dela"],
  [
    "app/(app)/anuncios/[itemId]/page.tsx",
    "a \"Alteração em\" do Diagnóstico; corrigida na D-648 (#321), que espera a migration do C-83 -- sai daqui no merge dela",
  ],
  [
    "lib/price-filters.ts",
    "a janela da `/precos` começa à meia-noite UTC; a D-640 (#310, em rascunho até a migration do C-81) mexe no mesmo arquivo, e a correção vem depois dela",
  ],
]);

/** Troca os comentários por espaços, preservando as quebras de linha (e o número da linha). */
function semComentarios(texto) {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, (bloco) => bloco.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (linha, antes) => antes + " ".repeat(linha.length - antes.length));
}

const PREVISAO = /expected(?:_at|At)/;

/** Devolve as violações de um texto: `[{ linha, tipo }]`. */
export function violacoes(texto) {
  const limpo = semComentarios(texto);
  const achadas = [];
  const linha = (i) => limpo.slice(0, i).split("\n").length;

  for (const m of limpo.matchAll(/toISOString\(\)\s*(?:\.slice\(\s*0\s*,\s*10\s*\)|\.split\(\s*["']T["']\s*\)\s*\[\s*0\s*\])/g)) {
    achadas.push({ linha: linha(m.index), tipo: "toISOString() recortado: o dia em UTC" });
  }

  for (const m of limpo.matchAll(/[\w$.?]*(?:_at|At)\s*\.slice\(\s*0\s*,\s*10\s*\)/g)) {
    if (PREVISAO.test(m[0])) continue;
    achadas.push({ linha: linha(m.index), tipo: `${m[0]}: o começo do texto ISO, o dia em UTC` });
  }

  for (const m of limpo.matchAll(/formatBusinessDate\(\s*([\w$.?]*(?:_at|At))\s*\)/g)) {
    if (PREVISAO.test(m[1])) continue;
    achadas.push({ linha: linha(m.index), tipo: `formatBusinessDate(${m[1]}): instante vira "—"` });
  }

  return achadas;
}

// Prova de carga: a detecção precisa achar o que deve e calar o que não deve.
const PROVAS = [
  ["p_date_to: hoje.toISOString().slice(0, 10),", 1],
  ['const dia = agora.toISOString().split("T")[0];', 1],
  ["{formatBusinessDate(row.last_movement_at.slice(0, 10))}", 1],
  ["detail: `em ${input.ai.budgetExceededAt.slice(0, 10)}`", 1],
  ["age: formatAge(row.created_at, agora) ?? formatBusinessDate(row.created_at),", 1],
  ["{formatBusinessDate(info.expected_at.slice(0, 10))}", 0],
  ["{formatBusinessDate(expectedAt)}", 0],
  ["{formatBusinessDate(linha.metric_date)}", 0],
  ["{formatDay(row.last_movement_at)}", 0],
  ["// era toISOString().slice(0, 10), o dia em UTC", 0],
  ["/* `formatBusinessDate(created_at)` dava \"—\" */", 0],
  ['const url = "https://x.test"; const d = hoje.toISOString().slice(0, 10);', 1],
];

for (const [amostra, esperado] of PROVAS) {
  if (violacoes(amostra).length !== esperado) {
    console.error(`check:dia-de-negocio — a detecção quebrou: esperava ${String(esperado)} em ${JSON.stringify(amostra)}`);
    process.exit(1);
  }
}

const arquivos = [];

function varrer(dir) {
  for (const entrada of readdirSync(dir)) {
    const caminho = join(dir, entrada);

    if (statSync(caminho).isDirectory()) varrer(caminho);
    else if (/\.(ts|tsx)$/.test(entrada) && !/\.test\.tsx?$/.test(entrada)) arquivos.push(caminho);
  }
}

for (const raiz of RAIZES) varrer(raiz);

const novas = [];
const limpos = [];

for (const arquivo of arquivos) {
  const rel = relative(".", arquivo).replaceAll("\\", "/");

  if (ISENTOS.has(rel)) continue;

  const achadas = violacoes(readFileSync(arquivo, "utf8"));

  if (PENDENTES.has(rel)) {
    if (achadas.length === 0) limpos.push(rel);
    continue;
  }

  for (const v of achadas) novas.push(`${rel}:${String(v.linha)} — ${v.tipo}`);
}

for (const pendente of PENDENTES.keys()) {
  if (!arquivos.some((a) => relative(".", a).replaceAll("\\", "/") === pendente)) limpos.push(`${pendente} (não existe mais)`);
}

if (novas.length > 0) {
  console.error(`check:dia-de-negocio — ${String(novas.length)} dia(s) tirado(s) de instante sem o fuso de São Paulo:\n`);
  for (const n of novas) console.error(`  ${n}`);
  console.error(
    "\nPara mostrar, use `formatDay` ou `formatDateTime`; para montar janela, `toSalesMetricDate`, `hojeSaoPaulo` ou\n" +
      "`lastBusinessDays` (D-050, D-656). `formatBusinessDate` é só para `AAAA-MM-DD`.",
  );
  process.exit(1);
}

if (limpos.length > 0) {
  console.error(`check:dia-de-negocio — ${String(limpos.length)} arquivo(s) na lista de pendências já sem o padrão:\n`);
  for (const l of limpos) console.error(`  ${l}`);
  console.error("\nTire-os de PENDENTES em scripts/check-dia-de-negocio.mjs: a lista só diminui.");
  process.exit(1);
}

console.log(
  `check:dia-de-negocio ok — ${String(arquivos.length)} arquivos; ${String(PENDENTES.size)} pendente(s), nenhum dia novo tirado de instante sem o fuso.`,
);
