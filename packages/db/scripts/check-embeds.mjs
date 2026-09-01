/**
 * Pergunta ao PostgREST real se TODA projeção com embed do repo é aceita.
 *
 * **Por que existe.** Um `select=` do PostgREST é uma linguagem própria,
 * avaliada só no servidor. Os fakes das suítes de unidade ignoram a string
 * inteira (`select: () => self`) — de propósito, porque modelá-la seria
 * reimplementar o PostgREST. Consequência: uma projeção inválida passa VERDE
 * em toda a suíte e quebra em produção.
 *
 * Já aconteceu: em D-188, a forma natural de um embed foi recusada com
 * `PGRST201` porque `sku_components` tem duas chaves estrangeiras para `skus`
 * e o PostgREST não escolhe sozinho. Nenhum dos 510 testes de unidade viu.
 *
 * D-191 varreu o repo com este script: **33 projeções, todas aceitas**. O
 * valor daqui para a frente é a próxima — a que alguém vai escrever amanhã.
 *
 * Como rodar (com o Supabase local de pé):
 *
 *   eval "$(pnpm exec supabase status -o env)"
 *   API_URL="$API_URL" SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
 *     pnpm --filter @sb/db run check:embeds
 *
 * Sai com código 1 se alguma for recusada.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Dois nomes para cada, e isto NAO e indecisao: `supabase status -o env`
// emite `API_URL`/`SERVICE_ROLE_KEY`, enquanto o CI e o resto do repo usam
// `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`. Aceitar os dois faz
// o script rodar em qualquer um dos dois ambientes sem variavel extra --
// exportar a variavel errada foi exatamente o que quebrou a primeira
// tentativa deste passo no CI.
const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

if (API_URL == null || KEY == null) {
  console.error("faltam a URL e a chave de service role no ambiente");
  console.error('rode antes: eval "$(pnpm exec supabase status -o env)"');
  process.exit(1);
}

const RAIZ = process.env.CHECK_EMBEDS_ROOT ?? "../..";
const ALVOS = ["apps/api/src", "apps/web/app", "apps/web/components", "apps/web/lib", "apps/worker/src", "packages"];
const IGNORAR = new Set(["node_modules", "dist", ".next", ".turbo"]);

function arquivos(dir) {
  const saida = [];

  for (const entrada of readdirSync(dir)) {
    if (IGNORAR.has(entrada)) continue;

    const caminho = join(dir, entrada);

    if (statSync(caminho).isDirectory()) {
      saida.push(...arquivos(caminho));
    } else if (/\.tsx?$/.test(entrada) && !/\.test\.tsx?$/.test(entrada)) {
      saida.push(caminho);
    }
  }

  return saida;
}

/**
 * `.from("tabela")` seguido do `.select("projeção")` da MESMA cadeia.
 *
 * O `(?:(?!\.from\()[\s\S])*?` é o que torna isto correto: proíbe outro
 * `.from(` no meio. Sem ele, o extrator pareia a tabela de uma consulta com a
 * projeção da seguinte e acusa falhas que não existem — foi o que a primeira
 * versão deste script fez, reportando seis, todas artefato.
 *
 * Só interessa projeção COM embed: parêntese dentro da string.
 */
const PADRAO = /\.from\(\s*"([a-z_]+)"\s*\)((?:(?!\.from\()[\s\S])*?)\.select\(\s*"([^"]*\([^"]*)"/g;

const encontradas = [];

for (const alvo of ALVOS) {
  let lista;

  try {
    lista = arquivos(join(RAIZ, alvo));
  } catch {
    continue;
  }

  for (const arquivo of lista) {
    for (const m of readFileSync(arquivo, "utf8").matchAll(PADRAO)) {
      encontradas.push({ arquivo, tabela: m[1], projecao: m[3].replace(/\s+/g, " ").trim() });
    }
  }
}

if (encontradas.length === 0) {
  console.error("nenhuma projeção com embed encontrada — o extrator provavelmente quebrou");
  process.exit(1);
}

let falhas = 0;

for (const { arquivo, tabela, projecao } of encontradas) {
  const resposta = await fetch(
    `${API_URL}/rest/v1/${tabela}?select=${encodeURIComponent(projecao)}&limit=1`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } },
  );

  if (resposta.ok) continue;

  falhas += 1;

  const corpo = await resposta.json().catch(() => ({}));

  console.error(`RECUSADA  ${tabela}  (${arquivo})`);
  console.error(`          ${String(resposta.status)} ${corpo.code ?? ""} ${corpo.message ?? ""}`);
  console.error(`          select=${projecao}`);
}

if (falhas > 0) {
  console.error(`\n${String(falhas)} de ${String(encontradas.length)} projeções recusadas pelo PostgREST.`);
  process.exit(1);
}

console.log(`check:embeds ok — ${String(encontradas.length)} projeções com embed, todas aceitas.`);
