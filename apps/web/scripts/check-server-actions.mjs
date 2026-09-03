/**
 * Procura export que NÃO é função assíncrona num módulo `"use server"`.
 *
 * **Por que existe.** O contrato do Next para um módulo `"use server"` é que
 * todo export seja uma função assíncrona: o bundler troca cada um por uma
 * referência de servidor. Uma constante exportada de lá chega ao componente
 * cliente como essa referência — não como o valor. `.map(...)` deixa de
 * existir, e a página estoura em runtime.
 *
 * `build` passa. `typecheck` passa. `lint` passa. É a classe D-131 — não
 * quebra, mente.
 *
 * **Achado em D3**, quando a sidebar nova passou a linkar telas que o menu
 * antigo não linkava, e uma varredura dos 28 links encontrou duas HTTP 500:
 *
 *   - `/atendimento/conhecimento` — quebrava SEMPRE (o formulário renderiza
 *     incondicionalmente). Ninguém tinha visto porque nada no menu apontava
 *     para lá; só o cabeçalho da Caixa de Entrada.
 *   - `/sugestoes` — quebrava só quando existia ao menos UMA sugestão. Com a
 *     tabela vazia a linha nunca renderiza. Latente, e pior por isso: a tela
 *     funciona até o primeiro usuário usá-la. Provado inserindo uma linha.
 *
 * **O que ele NÃO pega**, dito para ninguém confundir silêncio com garantia:
 * um export declarado com `export { X }` no fim do arquivo, ou reexportado
 * (`export * from`). Ambos são formas que este repositório não usa hoje —
 * medido — e se passarem a ser usadas, esta varredura fica cega sem avisar.
 * `interface` e `type` são ignorados de propósito: somem na compilação e nunca
 * chegam ao bundle.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RAIZES = ["app", "lib", "components"];

function arquivos(dir) {
  const saida = [];

  for (const entrada of readdirSync(dir)) {
    const caminho = join(dir, entrada);

    if (statSync(caminho).isDirectory()) {
      if (entrada === "node_modules" || entrada === ".next") continue;
      saida.push(...arquivos(caminho));
      continue;
    }

    if (entrada.endsWith(".ts") || entrada.endsWith(".tsx")) saida.push(caminho);
  }

  return saida;
}

const problemas = [];
let modulos = 0;

for (const raiz of RAIZES) {
  let lista;

  try {
    lista = arquivos(raiz);
  } catch {
    continue;
  }

  for (const caminho of lista) {
    const texto = readFileSync(caminho, "utf8");

    // A diretiva vale para o módulo inteiro só quando está na PRIMEIRA
    // instrução do arquivo. Dentro de uma função ela marca só aquela função,
    // e aí o resto do módulo é normal.
    if (!/^\s*["']use server["'];/.test(texto)) continue;

    modulos += 1;

    const linhas = texto.split("\n");

    linhas.forEach((linha, i) => {
      const m = /^export\s+(?!type\b|interface\b|async\s+function\b|default\s+async\s+function\b)(const|let|var|function|class|enum)\s+([A-Za-z0-9_$]+)/.exec(linha);

      if (m === null) return;

      problemas.push({ caminho, linha: i + 1, tipo: m[1], nome: m[2], trecho: linha.trim().slice(0, 100) });
    });
  }
}

if (problemas.length > 0) {
  console.error(`check:server-actions — ${problemas.length} export(s) que não é função assíncrona em módulo "use server":\n`);

  for (const p of problemas) {
    console.error(`  ${p.caminho}:${p.linha}  (${p.tipo} ${p.nome})`);
    console.error(`    ${p.trecho}`);
  }

  console.error(`
Cada um chega ao componente cliente como referência de servidor, não como o
valor — e a página estoura em runtime, com build e typecheck verdes.

Mova o valor para um módulo irmão sem a diretiva (o padrão do repositório é
\`constants.ts\` ao lado do \`actions.ts\`) e importe de lá nos dois lados.`);
  process.exit(1);
}

console.log(`check:server-actions ok — ${String(modulos)} módulos "use server", nenhum export que não seja função assíncrona.`);
