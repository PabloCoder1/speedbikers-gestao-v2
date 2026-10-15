/**
 * Procura navegação INTERNA que recarrega o documento inteiro (D-500, D-501).
 *
 * **Por que existe.** Um `<form method="get">` nativo e um `<a href="/rota">`
 * levam para a mesma tela que um `<Link>` levaria — e o build, o typecheck e o
 * e2e passam com qualquer um. A diferença só aparece no navegador: a recarga
 * baixa de novo HTML e JavaScript, refaz a hidratação, a assinatura de Realtime
 * e as leituras do `Shell`, e mostra a tela em branco no meio. Medido em
 * `/estoque` com 600 ms de latência (D-500): busca de 1.304 ms para 663 ms,
 * opção de menu de 1.268 ms para 926 ms, só por trocar a recarga pela
 * navegação suave. Era o padrão de 26 formulários e 30 links — e volta no
 * primeiro formulário novo escrito do jeito que o HTML ensina.
 *
 * **O que reprova:**
 *
 *   - `<form method="get">` — use `FormularioFiltro`
 *     (`components/formulario-filtro.tsx`);
 *   - `<a href>` para uma rota do próprio app — use `<Link>`, ou `LinkDeFiltro`
 *     quando o destino é a mesma tela (`components/link-de-filtro.tsx`).
 *
 * **O que NÃO reprova:** `<a>` com `download` ou `target="_blank"`, `href`
 * externo (`http`, `mailto:`, `tel:`), âncora (`#`) e as rotas que devolvem
 * arquivo ou não são tela (`/export`, `/api/`, `/auth/`, `xlsx`, `csv`, `pdf`).
 * E ele não sabe se um `<Link>` leva para a MESMA tela sem o
 * `CarregandoSeODemorar` — isso depende do valor do `href` em tempo de
 * execução; quem pega é a revisão (e o `LinkDeFiltro` deixa o certo mais curto).
 *
 * **A lista de pendências só diminui.** As telas que ainda têm o padrão antigo
 * estão em `PENDENTES`, cada uma com o motivo. Arquivo novo com o padrão
 * reprova; arquivo da lista que ficou limpo também reprova, para sair dela.
 *
 * Ele se prova na carga: se a detecção parar de achar os exemplos abaixo, falha
 * alto em vez de ficar verde sem detectar nada.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const RAIZES = ["app", "components"];

/** O componente que IMPLEMENTA o GET suave renderiza um `<form method="get">` de verdade. */
const ISENTOS = new Map([
  ["components/formulario-filtro.tsx", "é o formulário GET suave: o `method` fica para antes do JavaScript carregar"],
  ["app/compras/[id]/export-actions.tsx", "links de download do Excel e do PDF do pedido (rota de arquivo)"],
  ["app/fornecedores/canais.tsx", "WhatsApp, telefone, e-mail e site do fornecedor (destinos externos)"],
]);

/**
 * Telas que ainda recarregam, com o motivo de ainda não terem migrado. Sai
 * daqui quem migrar; ninguém entra.
 */
const PENDENTES = new Map([
  ["app/central/page.tsx", "na fila do Agente 2 (T8, central e meta)"],
  ["app/central/produtos/page.tsx", "na fila do Agente 2 (T8, central e meta)"],
  ["app/compras/page.tsx", "na fila do Agente 2 (T-R3, sugestão de compra)"],
  ["app/curva-abc/page.tsx", "tela do Agente 2 (multicanal); combinar antes de tocar"],
  ["app/reposicao/page.tsx", "na fila do Agente 2 (T-R3, demanda da Shopee na cobertura)"],
]);

/** Fim da tag de abertura, respeitando chaves, aspas e template strings. */
function fimDaTag(texto, inicio) {
  let profundidade = 0;
  let aspas = null;

  for (let i = inicio; i < texto.length; i += 1) {
    const ch = texto[i];

    if (aspas !== null) {
      if (ch === aspas) aspas = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") aspas = ch;
    else if (ch === "{") profundidade += 1;
    else if (ch === "}") profundidade -= 1;
    else if (ch === ">" && profundidade === 0) return i;
  }

  return texto.length - 1;
}

const NAO_E_TELA = /download|target=["']_blank|mailto:|tel:|https?:|\/export|\/api\/|\/auth\/|xlsx|csv|pdf|href=["']#/;

/** Devolve as violações de um texto: `[{ linha, tipo }]`. */
export function violacoes(texto) {
  const achadas = [];
  const linha = (i) => texto.slice(0, i).split("\n").length;

  for (const m of texto.matchAll(/<form\b/g)) {
    const tag = texto.slice(m.index, fimDaTag(texto, m.index) + 1);

    if (/\bmethod=(["'])get\1/i.test(tag)) achadas.push({ linha: linha(m.index), tipo: '<form method="get">' });
  }

  for (const m of texto.matchAll(/<a\b/g)) {
    const tag = texto.slice(m.index, fimDaTag(texto, m.index) + 1);

    if (!/\bhref=/.test(tag) || NAO_E_TELA.test(tag)) continue;

    achadas.push({ linha: linha(m.index), tipo: "<a href> interno" });
  }

  return achadas;
}

// Prova de carga: a detecção precisa achar o que deve e calar o que não deve.
const PROVAS = [
  ['<form method="get" action="/x">', 1],
  ["<form\n  className=\"y\"\n  method='GET'\n>", 1],
  ['<form action={salvar}>', 0],
  ["<a href={`/estoque?pagina=${String(n)}`}>", 1],
  ['<a className="z" href="/vinculacoes">', 1],
  ['<a href="/precos/export/xlsx">', 0],
  ['<a href={url} download>', 0],
  ['<a href="https://exemplo.com" target="_blank">', 0],
  ['<a href={linkEmail(x)}>', 1],
];

for (const [amostra, esperado] of PROVAS) {
  if (violacoes(amostra).length !== esperado) {
    console.error(`check:navegacao-suave — a detecção quebrou: esperava ${String(esperado)} em ${JSON.stringify(amostra)}`);
    process.exit(1);
  }
}

const arquivos = [];

function varrer(dir) {
  for (const entrada of readdirSync(dir)) {
    const caminho = join(dir, entrada);

    if (statSync(caminho).isDirectory()) varrer(caminho);
    else if (entrada.endsWith(".tsx")) arquivos.push(caminho);
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
  console.error(`check:navegacao-suave — ${String(novas.length)} navegação(ões) interna(s) que recarregam o documento:\n`);

  for (const n of novas) console.error(`  ${n}`);

  console.error(
    "\nUse `FormularioFiltro` no lugar de `<form method=\"get\">` e `<Link>` (ou `LinkDeFiltro`, para a mesma tela)\n" +
      "no lugar de `<a href>` interno (D-500, D-501). Download e destino externo: `download`, `target=\"_blank\"` ou\n" +
      "uma rota de arquivo passam.",
  );
  process.exit(1);
}

if (limpos.length > 0) {
  console.error(`check:navegacao-suave — ${String(limpos.length)} arquivo(s) na lista de pendências já sem o padrão antigo:\n`);

  for (const l of limpos) console.error(`  ${l}`);

  console.error("\nTire-os de PENDENTES em scripts/check-navegacao-suave.mjs: a lista só diminui.");
  process.exit(1);
}

console.log(
  `check:navegacao-suave ok — ${String(arquivos.length)} arquivos; ${String(PENDENTES.size)} tela(s) pendente(s), nenhuma navegação interna nova com recarga.`,
);
