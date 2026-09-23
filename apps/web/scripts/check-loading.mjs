/**
 * Toda pasta de `app/` que tem página (nela ou abaixo dela) precisa de um
 * `loading.tsx`.
 *
 * **Por que existe.** `loading.tsx` só aparece quando o segmento em que ele mora
 * troca de filho. Com um só, na raiz, a tela de carregamento entrava ao trocar
 * de SEÇÃO (`/vendas` → `/anuncios`) e NÃO entrava dentro dela: `/anuncios` →
 * `/anuncios/MLB…`, `/estoque` → `/estoque/movimentacoes`, `/notas-fiscais` →
 * `/notas-fiscais/nova` congelavam a tela antiga até a nova chegar. Medido em
 * 2026-09-18 com as respostas de navegação atrasadas em 2,5 s: 6 de 8
 * navegações sem carregamento nenhum.
 *
 * Build, typecheck e lint passam sem o arquivo — a página funciona, só fica
 * parada. É exatamente o tipo de falta que ninguém vê em teste rápido.
 *
 * **E o arquivo tem de trazer a MOLDURA.** O `Shell` mora dentro de cada
 * página, não num layout: o `loading.tsx` de uma pasta substitui a tela
 * inteira, sidebar e barra superior incluídas. Um `loading.tsx` próprio que
 * desenhe só o miolo apaga a moldura a cada navegação para aquela pasta — foi
 * o que `/configuracoes` fez em 2026-09-22, com esta guarda verde porque ela só
 * conferia que o arquivo existia. Agora todo `loading.tsx` abaixo da raiz ou
 * reexporta o da raiz, ou usa `CarregandoTela` (que aceita o miolo próprio
 * como `children`). `/login` é a exceção deliberada: a porta de entrada fica
 * fora da moldura de um sistema em que a pessoa ainda não entrou.
 *
 * **O que ele NÃO pega:** troca só de `?filtro=` na MESMA página por `<Link>`
 * (nenhum segmento muda, nenhum `loading.tsx` entra). Isso é coberto pelo
 * `CarregandoSeODemorar` nos componentes compartilhados que fazem esse tipo de
 * link (`KpiStrip`, `FilterPill`); `<a>` comum recarrega a página, e aí o
 * `loading.tsx` aparece pelo streaming.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP = "app";

/** Pastas que não precisam: `/cobertura` só redireciona (D-288), nunca desenha. */
const ISENTAS = new Set(["cobertura"]);

/** Pastas cujo carregamento fica FORA da moldura de propósito (`app/login/loading.tsx`). */
const SEM_MOLDURA = new Set(["login"]);

/**
 * O `loading.tsx` traz a moldura se reexporta o da raiz (`../loading`, um
 * `../` por nível) ou se usa `CarregandoTela` — o único componente que a
 * desenha.
 */
function trazMoldura(arquivo) {
  const texto = readFileSync(arquivo, "utf8");

  return /export\s*\{\s*default\s*\}\s*from\s*["'](?:\.\.\/)+loading["']/.test(texto) || /<CarregandoTela[\s>/]/.test(texto);
}

const semMoldura = [];

function temPagina(dir) {
  for (const entrada of readdirSync(dir)) {
    const caminho = join(dir, entrada);

    if (statSync(caminho).isDirectory()) {
      if (temPagina(caminho)) return true;
    } else if (entrada === "page.tsx") {
      return true;
    }
  }

  return false;
}

const faltando = [];
let verificadas = 0;

function varrer(dir) {
  const rel = relative(APP, dir).replaceAll("\\", "/");

  if (ISENTAS.has(rel.split("/")[0] ?? "")) return;

  if (temPagina(dir)) {
    verificadas += 1;

    const arquivo = join(dir, "loading.tsx");

    if (!existsSync(arquivo)) {
      faltando.push(rel === "" ? "app/" : `app/${rel}/`);
    } else if (rel !== "" && !SEM_MOLDURA.has(rel.split("/")[0] ?? "") && !trazMoldura(arquivo)) {
      semMoldura.push(`app/${rel}/loading.tsx`);
    }
  }

  for (const entrada of readdirSync(dir)) {
    const caminho = join(dir, entrada);

    if (statSync(caminho).isDirectory()) varrer(caminho);
  }
}

varrer(APP);

if (faltando.length > 0) {
  console.error(`check:loading — ${String(faltando.length)} pasta(s) com página e sem loading.tsx:\n`);

  for (const pasta of faltando) console.error(`  ${pasta}`);

  console.error(
    '\nCrie `loading.tsx` com uma linha, reexportando o da raiz: `export { default } from "../loading";`\n' +
      "(um `../` por nível). Sem ele, navegar para esta pasta a partir da mesma seção congela a tela antiga.",
  );
  process.exit(1);
}

if (semMoldura.length > 0) {
  console.error(`check:loading — ${String(semMoldura.length)} loading.tsx sem a moldura do app:\n`);

  for (const arquivo of semMoldura) console.error(`  ${arquivo}`);

  console.error(
    "\nO `Shell` mora dentro da página: este fallback substitui a tela inteira, e sem a moldura a sidebar e a\n" +
      'barra superior somem a cada navegação para cá. Reexporte o da raiz (`export { default } from "../loading";`)\n' +
      "ou, se a tela tem forma própria, passe o miolo para `CarregandoTela` como children.",
  );
  process.exit(1);
}

console.log(`check:loading ok — ${String(verificadas)} pasta(s) com página, todas com loading.tsx e a moldura do app.`);
