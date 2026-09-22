/**
 * Confere que cada termo da tabela `INCLUI` de `lib/settings-hub.ts` existe,
 * LITERALMENTE, no arquivo da tela dona que ele declara.
 *
 * **Por que existe.** `/configuracoes` é um hub que APONTA (D-233): não edita
 * nada, e por isso não tem como divergir dos dados. A linha "Inclui: …" é a
 * única coisa da tela que não é número do banco nem link — é PROSA sobre o que
 * mora em outra tela. Prosa sobre a tela dos outros é exatamente a forma de
 * D-224 que ninguém vê apodrecer: o dia em que "Cobertura desejada" virar
 * "Cobertura alvo" em `/reposicao/configuracoes`, nada quebra. O build passa, o
 * typecheck passa, o e2e passa, e o hub passa a ensinar uma palavra que não
 * existe mais — mandando o operador procurar na tela um rótulo que ele não vai
 * achar.
 *
 * É a mesma classe de defeito de `check:table-styles`: não quebra, MENTE. Os
 * três juízes puseram esta guarda como CONDIÇÃO da linha "Inclui:", e sem ela a
 * linha não deveria ter sido escrita.
 *
 * **O que ele NÃO pega**, dito para ninguém confundir silêncio com garantia:
 *
 *   - **Termo certo no lugar errado.** A guarda confere que a string existe no
 *     arquivo, não que ela seja um rótulo visível: "Teto" casaria com um
 *     comentário que falasse de teto. O que ela impede é o caso real — o rótulo
 *     mudar e o hub continuar dizendo o nome velho.
 *   - **Rótulo que a tela dona compõe em tempo de execução** (`{`Prazo de
 *     ${dias}`}`). Nenhum dos sete termos de hoje é assim; se algum passar a
 *     ser, o termo some do arquivo e a guarda fica vermelha — o que é o
 *     comportamento certo: aquele termo deixou de ser literal e não pode
 *     continuar copiado aqui.
 *   - **A tela dona sumir de vez.** Aí o arquivo não existe e a guarda também
 *     reprova, com outra mensagem.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FONTE = join(RAIZ, "lib", "settings-hub.ts");

/**
 * Recorta o bloco `export const INCLUI = { … } as const satisfies` e lê os
 * pares `{ termo, arquivo }` de dentro dele.
 *
 * Lê por REGEX e não por import: este arquivo é `.mjs` e roda sem build (é o
 * que `check-table-styles.mjs` já faz, e a mesma razão pela qual `scripts/**`
 * está fora do eslint com tipos).
 */
function lerTabela(texto) {
  const inicio = texto.indexOf("export const INCLUI");

  if (inicio === -1) return null;

  const fim = texto.indexOf("as const satisfies", inicio);

  if (fim === -1) return null;

  const bloco = texto.slice(inicio, fim);
  const pares = [...bloco.matchAll(/\{\s*termo:\s*"([^"]+)",\s*arquivo:\s*"([^"]+)"\s*\}/g)];

  return pares.map(([, termo, arquivo]) => ({ termo, arquivo }));
}

// ---------------------------------------------------------------------------
// O detector se prova antes de julgar o repo.
//
// A varredura não vale nada com a leitura quebrada: uma regex que casasse com
// nada deixaria a esteira VERDE sem conferir termo nenhum — e "verde por não
// ter olhado" é pior do que não ter guarda, porque alguém confia nela.
// ---------------------------------------------------------------------------
const CASOS = [
  {
    nome: "le os pares da tabela",
    fonte: `export const INCLUI = {
  reposicao: [
    { termo: "Prazo do fornecedor", arquivo: "app/reposicao/configuracoes/page.tsx" },
    { termo: "Teto", arquivo: "app/reposicao/configuracoes/page.tsx" },
  ],
} as const satisfies Record<X, Y>;`,
    esperado: 2,
  },
  {
    nome: "nao le pares de fora do bloco",
    fonte: `const OUTRA = [{ termo: "Fora", arquivo: "x.tsx" }];
export const INCLUI = {
  ia: [{ termo: "Integrações", arquivo: "components/nav.tsx" }],
} as const satisfies Record<X, Y>;
const DEPOIS = [{ termo: "Depois", arquivo: "y.tsx" }];`,
    esperado: 1,
  },
  {
    nome: "tabela ausente e reprovada, nao ignorada",
    fonte: "export const OUTRA_COISA = {};",
    esperado: null,
  },
];

for (const caso of CASOS) {
  const lido = lerTabela(caso.fonte);
  const obtido = lido === null ? null : lido.length;

  if (obtido !== caso.esperado) {
    console.error(`check:settings-vocabulary — AUTO-TESTE FALHOU: "${caso.nome}"`);
    console.error(`  esperado ${String(caso.esperado)}, a leitura devolveu ${String(obtido)}.`);
    console.error(`
Com a leitura quebrada a varredura fica verde sem conferir nada. Conserte a
expressão antes de confiar no resultado desta esteira.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------

let fonte;

try {
  fonte = readFileSync(FONTE, "utf8");
} catch {
  console.error(`check:settings-vocabulary — não consegui ler ${FONTE}.`);
  process.exit(1);
}

const tabela = lerTabela(fonte);

if (tabela === null || tabela.length === 0) {
  console.error(`check:settings-vocabulary — não achei a tabela INCLUI em lib/settings-hub.ts.

Ou ela foi removida, ou mudou de forma. Enquanto a tela imprimir a linha
"Inclui: …", esta tabela precisa existir e ser legível daqui.`);
  process.exit(1);
}

const cache = new Map();

function conteudo(arquivo) {
  if (cache.has(arquivo)) return cache.get(arquivo);

  let texto;

  try {
    texto = readFileSync(join(RAIZ, arquivo), "utf8");
  } catch {
    texto = null;
  }

  cache.set(arquivo, texto);

  return texto;
}

const problemas = [];

for (const { termo, arquivo } of tabela) {
  const texto = conteudo(arquivo);

  if (texto === null) {
    problemas.push({ termo, arquivo, motivo: "o arquivo da tela dona não existe" });
    continue;
  }

  if (!texto.includes(termo)) {
    problemas.push({ termo, arquivo, motivo: "o termo não aparece mais no arquivo" });
  }
}

if (problemas.length > 0) {
  console.error(
    `check:settings-vocabulary — ${String(problemas.length)} termo(s) da linha "Inclui:" não existem mais na tela dona:\n`,
  );

  for (const p of problemas) {
    console.error(`  "${p.termo}"  em ${p.arquivo}  — ${p.motivo}`);
  }

  console.error(`
/configuracoes está ensinando uma palavra que a tela dona não usa mais: quem
seguir o hub vai procurar na tela um rótulo que não existe. Nada quebrou, e é
justamente por isso que esta guarda existe.

Conserte em apps/web/lib/settings-hub.ts, na tabela INCLUI: o termo tem de ser a
string LITERAL da tela dona, sem sinônimo e sem paráfrase. Se o rótulo mudou de
propósito, o texto novo é que entra aqui.`);
  process.exit(1);
}

const arquivos = new Set(tabela.map((t) => t.arquivo));

console.log(
  `check:settings-vocabulary ok — ${String(tabela.length)} termo(s) da linha "Inclui:" conferidos em ${String(
    arquivos.size,
  )} tela(s) dona(s).`,
);
