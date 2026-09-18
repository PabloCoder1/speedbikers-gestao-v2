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
 * **O que ele NÃO pega:** troca só de `?filtro=` na MESMA página por `<Link>`
 * (nenhum segmento muda, nenhum `loading.tsx` entra). Isso é coberto pelo
 * `CarregandoSeODemorar` nos componentes compartilhados que fazem esse tipo de
 * link (`KpiStrip`, `FilterPill`); `<a>` comum recarrega a página, e aí o
 * `loading.tsx` aparece pelo streaming.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP = "app";

/** Pastas que não precisam: `/cobertura` só redireciona (D-288), nunca desenha. */
const ISENTAS = new Set(["cobertura"]);

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

    if (!existsSync(join(dir, "loading.tsx"))) faltando.push(rel === "" ? "app/" : `app/${rel}/`);
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

console.log(`check:loading ok — ${String(verificadas)} pasta(s) com página, todas com loading.tsx.`);
