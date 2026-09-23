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
 *     ${dias}`}`). Nenhum dos termos de hoje é assim; se algum passar a
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
 *
 * **Cada `termo:` do bloco tem de virar um par lido, ou a leitura reprova.** A
 * regex de antes só casava `termo` antes de `arquivo` e com aspas duplas: uma
 * entrada escrita `{ arquivo: "…", termo: "…" }` — TypeScript válido, que o
 * `satisfies` aceita — era pulada em silêncio, e a guarda dizia "ok" com um
 * termo a menos sem nunca ter olhado para ele. Agora cada objeto é lido com as
 * chaves em qualquer ordem e aspas simples ou duplas, e o que sobrar (um
 * `termo:` que não virou par, como uma template string) devolve `ilegiveis`
 * maior que zero — que é reprovação, não aviso.
 *
 * Devolve `null` quando o bloco não existe; senão `{ pares, ilegiveis }`.
 */
function lerTabela(texto) {
  const inicio = texto.indexOf("export const INCLUI");

  if (inicio === -1) return null;

  const fim = texto.indexOf("as const satisfies", inicio);

  if (fim === -1) return null;

  // Comentário de linha inteira sai antes de contar: "termo:" dentro de um
  // comentário não é entrada da tabela.
  const bloco = texto
    .slice(inicio, fim)
    .split("\n")
    .filter((linha) => !linha.trimStart().startsWith("//"))
    .join("\n");

  const valorDe = (objeto, chave) => {
    const achado = objeto.match(new RegExp(`\\b${chave}\\s*:\\s*(["'])((?:(?!\\1).)+)\\1`));

    return achado === null ? null : achado[2];
  };

  const pares = [];

  for (const [objeto] of bloco.matchAll(/\{[^{}]*\}/g)) {
    if (!/\btermo\s*:/.test(objeto)) continue;

    const termo = valorDe(objeto, "termo");
    const arquivo = valorDe(objeto, "arquivo");

    if (termo !== null && arquivo !== null) pares.push({ termo, arquivo });
  }

  const declarados = [...bloco.matchAll(/\btermo\s*:/g)].length;

  return { pares, ilegiveis: declarados - pares.length };
}

// ---------------------------------------------------------------------------
// O detector se prova antes de julgar o repo.
//
// A varredura não vale nada com a leitura quebrada: uma regex que casasse com
// nada deixaria a esteira VERDE sem conferir termo nenhum — e "verde por não
// ter olhado" é pior do que não ter guarda, porque alguém confia nela.
// ---------------------------------------------------------------------------
/**
 * `esperado` é `"<pares lidos>/<ilegiveis>"`, ou `null` para tabela ausente —
 * assim um caso afirma, de uma vez, o que foi lido E o que ficou sem ler.
 */
const CASOS = [
  {
    nome: "le os pares da tabela",
    fonte: `export const INCLUI = {
  reposicao: [
    { termo: "Prazo do fornecedor", arquivo: "app/reposicao/configuracoes/page.tsx" },
    { termo: "Teto", arquivo: "app/reposicao/configuracoes/page.tsx" },
  ],
} as const satisfies Record<X, Y>;`,
    esperado: "2/0",
  },
  {
    nome: "nao le pares de fora do bloco",
    fonte: `const OUTRA = [{ termo: "Fora", arquivo: "x.tsx" }];
export const INCLUI = {
  ia: [{ termo: "Integrações", arquivo: "components/nav.tsx" }],
} as const satisfies Record<X, Y>;
const DEPOIS = [{ termo: "Depois", arquivo: "y.tsx" }];`,
    esperado: "1/0",
  },
  {
    nome: "tabela ausente e reprovada, nao ignorada",
    fonte: "export const OUTRA_COISA = {};",
    esperado: null,
  },
  {
    // A mutação que a regex antiga deixava passar: chaves invertidas, aspas
    // simples e um campo a mais. Os três pares têm de ser LIDOS — é lendo que
    // a guarda descobre que "Teto máximo inexistente" não está na tela dona.
    nome: "le chaves em qualquer ordem, aspas simples e campo a mais",
    fonte: `export const INCLUI = {
  reposicao: [
    { arquivo: "app/reposicao/configuracoes/page.tsx", termo: "Teto máximo inexistente" },
    { termo: 'Segurança', arquivo: 'app/reposicao/configuracoes/page.tsx' },
    { termo: "Conectar conta", arquivo: "app/contas/page.tsx", somenteAdmin: true },
  ],
} as const satisfies Record<X, Y>;`,
    esperado: "3/0",
  },
  {
    // O que a guarda não sabe ler não pode sumir da conta: um termo em
    // template string (ou numa forma que ninguém previu) vira ILEGÍVEL, e
    // ilegível reprova a esteira.
    nome: "termo que nao vira par e contado como ilegivel",
    fonte: `export const INCLUI = {
  reposicao: [
    { termo: \`Prazo do fornecedor\`, arquivo: "app/reposicao/configuracoes/page.tsx" },
    { termo: "Teto", arquivo: "app/reposicao/configuracoes/page.tsx" },
  ],
} as const satisfies Record<X, Y>;`,
    esperado: "1/1",
  },
  {
    nome: "comentario com a palavra termo nao conta como entrada",
    fonte: `export const INCLUI = {
  // termo: "isto é um comentário"
  ia: [{ termo: "Integrações", arquivo: "components/nav.tsx" }],
} as const satisfies Record<X, Y>;`,
    esperado: "1/0",
  },
];

for (const caso of CASOS) {
  const lido = lerTabela(caso.fonte);
  const obtido = lido === null ? null : `${String(lido.pares.length)}/${String(lido.ilegiveis)}`;

  if (obtido !== caso.esperado) {
    console.error(`check:settings-vocabulary — AUTO-TESTE FALHOU: "${caso.nome}"`);
    console.error(`  esperado ${String(caso.esperado)}, a leitura devolveu ${String(obtido)} (pares/ilegíveis).`);
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

const lida = lerTabela(fonte);

if (lida === null || lida.pares.length === 0) {
  console.error(`check:settings-vocabulary — não achei a tabela INCLUI em lib/settings-hub.ts.

Ou ela foi removida, ou mudou de forma. Enquanto a tela imprimir a linha
"Inclui: …", esta tabela precisa existir e ser legível daqui.`);
  process.exit(1);
}

if (lida.ilegiveis !== 0) {
  console.error(`check:settings-vocabulary — ${String(lida.ilegiveis)} entrada(s) com "termo:" na tabela INCLUI que esta guarda não conseguiu ler.

Termo que a guarda não lê é termo que ela não confere — e aí o "ok" do fim seria
mentira. Escreva cada entrada como objeto literal, com termo e arquivo entre
aspas (simples ou duplas, em qualquer ordem): { termo: "…", arquivo: "…" }.`);
  process.exit(1);
}

const tabela = lida.pares;

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
