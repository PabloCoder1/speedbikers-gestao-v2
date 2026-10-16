/**
 * A moldura e o carregamento das telas (D-512, que substituiu a regra da D-382).
 *
 * **O que mudou.** Até a D-512, o `Shell` morava dentro de cada página e toda
 * pasta precisava de um `loading.tsx` com a moldura: sem ele, trocar de tela
 * dentro da mesma seção congelava a tela antiga (D-382 mediu 6 de 8 navegações
 * sem retorno nenhum). Mas o React só deixa o conteúdo substituir um esqueleto
 * 300 ms depois de mostrá-lo (`globalMostRecentFallbackTime + 300` no
 * `react-dom`), e com um esqueleto por pasta TODA troca de tela travava nesse
 * piso — 336 ms com o dado instantâneo, medido na D-511.
 *
 * **A regra agora:**
 * - as telas autenticadas moram no grupo `app/(app)/`, cujo `layout.tsx`
 *   desenha o `Shell` uma vez — ele persiste entre as telas;
 * - nenhuma pasta do grupo tem `loading.tsx`: a troca de tela mantém a tela
 *   anterior com o sinal da D-500 (`IndicadorDeNavegacao` no `Shell`, e
 *   `useLinkStatus` nos links da sidebar). Bloco lento dentro da tela vai num
 *   `Suspense` com esqueleto do tamanho dele (D-504, D-505, D-509);
 * - nenhuma página do grupo embrulha o próprio conteúdo no `Shell` — a moldura
 *   sairia dobrada;
 * - `app/loading.tsx`, ACIMA do layout do grupo, é o esqueleto da carga fria:
 *   aparece na primeira visita e não dispara na navegação entre as telas;
 * - página fora do grupo é exceção declarada: a entrada (`/login`, que fica
 *   fora da moldura de um sistema em que a pessoa ainda não entrou) e o
 *   redirecionamento de `/cobertura` (D-288).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP = "app";
const GRUPO = join(APP, "(app)");

/** Rotas com página que ficam FORA do grupo de propósito. */
const FORA_DO_GRUPO = new Set(["login", "cobertura"]);

const problemas = [];

function listar(dir, nome) {
  const achados = [];

  for (const entrada of readdirSync(dir)) {
    const caminho = join(dir, entrada);

    if (statSync(caminho).isDirectory()) achados.push(...listar(caminho, nome));
    else if (entrada === nome) achados.push(caminho);
  }

  return achados;
}

const rel = (caminho) => relative(".", caminho).replaceAll("\\", "/");

if (!existsSync(join(APP, "loading.tsx"))) {
  problemas.push("app/loading.tsx não existe: a carga fria fica sem esqueleto.");
}

const layout = join(GRUPO, "layout.tsx");

if (!existsSync(layout) || !/<Shell[\s>]/.test(readFileSync(layout, "utf8"))) {
  problemas.push("app/(app)/layout.tsx não existe ou não desenha o <Shell>: a moldura não persiste entre as telas.");
}

for (const arquivo of existsSync(GRUPO) ? listar(GRUPO, "loading.tsx") : []) {
  problemas.push(
    `${rel(arquivo)}: loading.tsx dentro do grupo — o React trava a troca de tela em ~300 ms depois de mostrar o esqueleto. Tire o arquivo; bloco lento vai num Suspense dentro da tela.`,
  );
}

for (const pagina of existsSync(GRUPO) ? listar(GRUPO, "page.tsx") : []) {
  if (/<Shell[\s>]/.test(readFileSync(pagina, "utf8"))) {
    problemas.push(`${rel(pagina)}: a página embrulha o próprio conteúdo no <Shell> — a moldura já vem do layout do grupo.`);
  }
}

for (const entrada of readdirSync(APP)) {
  const caminho = join(APP, entrada);

  if (!statSync(caminho).isDirectory() || entrada === "(app)" || FORA_DO_GRUPO.has(entrada)) continue;

  for (const pagina of listar(caminho, "page.tsx")) {
    problemas.push(`${rel(pagina)}: página fora do grupo app/(app)/ — tela autenticada nova mora no grupo, para herdar a moldura.`);
  }
}

if (existsSync(join(APP, "page.tsx"))) {
  problemas.push("app/page.tsx: a Home mora no grupo, em app/(app)/page.tsx.");
}

if (problemas.length > 0) {
  console.error(`check:loading — ${String(problemas.length)} problema(s):\n`);

  for (const problema of problemas) console.error(`  ${problema}`);

  process.exit(1);
}

const telas = listar(GRUPO, "page.tsx").length;

console.log(`check:loading ok — ${String(telas)} telas no grupo (app), moldura no layout, nenhum loading.tsx no grupo.`);
