/**
 * Procura leituras do Supabase em FILA que não precisavam estar em fila.
 *
 * **Por que existe.** Um Server Component que faz `await` de duas leituras
 * independentes paga as duas latências somadas antes de renderizar a primeira
 * linha. Não há erro, não há teste vermelho, e o código parece correto — o
 * custo só aparece no relógio de quem abre a página.
 *
 * Medido em 2026-09-01, deste ambiente contra o Supabase Dev: **~125 ms de
 * mediana por ida** (8 amostras, min 93, máx 222). O número é a latência
 * DESTA máquina e não vale como número de produção — o que vale é a
 * decomposição de D-185: o custo é POR CHAMADA e quase independente do que a
 * chamada faz, então quem manda é o número de idas. Duas em fila custam duas;
 * duas juntas custam uma.
 *
 * D-195 varreu as 45 páginas e achou **12 leituras em fila sem dependência**,
 * espalhadas por 9 telas. Todas foram para `Promise.all`. O valor daqui para
 * a frente é a décima terceira — a que alguém vai escrever amanhã.
 *
 * **O critério.** Uma leitura depende da anterior se o texto dela menciona
 * algum nome ligado por uma leitura anterior, direta ou transitivamente
 * (`organizationId` vem de `membership.data`, e conta como dependência). A
 * primeira versão desta varredura NÃO seguia os nomes derivados e por isso
 * inventava waterfall onde havia dependência real — mesma classe de erro da
 * varredura de D-193, e a correção foi a mesma: propagar transitivamente.
 *
 * **O que NÃO é waterfall, e o script não acusa:**
 *
 * - leitura dentro de `if`/`? :` — carregar só quando precisa é o padrão
 *   CERTO ("dados carregados por aba não aberta" é o defeito oposto);
 * - leitura que usa qualquer coisa vinda de uma leitura anterior;
 * - leitura marcada com `// fila-justificada: <razão>` na linha de cima.
 *   O escape existe porque nem toda ordem é dependência de dado — mas exige
 *   a razão escrita, que é o ponto.
 *
 * Como rodar:
 *
 *   pnpm --filter @sb/web run check:waterfalls
 *
 * Sai com código 1 se achar alguma.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RAIZES = (process.env.CHECK_WATERFALLS_ROOT ?? "app,components").split(",");
const IGNORAR = new Set(["node_modules", "dist", ".next", ".turbo"]);
const ESCAPE = /\/\/\s*fila-justificada:/;

function arquivos(dir) {
  const saida = [];

  for (const entrada of readdirSync(dir)) {
    if (IGNORAR.has(entrada)) continue;

    const caminho = join(dir, entrada);

    if (statSync(caminho).isDirectory()) {
      saida.push(...arquivos(caminho));
    } else if (/\.tsx$/.test(entrada) && !/\.test\.tsx$/.test(entrada)) {
      // Só o caminho de RENDER DO SERVIDOR, e o critério é o arquivo declarar
      // ou não `"use client"`:
      //
      // - Server Component: todo `await` dele acontece ANTES da página chegar
      //   ao navegador. Duas leituras em fila são duas latências somadas.
      // - Componente de cliente: o `await` roda em resposta a interação
      //   (digitar, abrir um seletor). Não é a mesma pergunta.
      // - `.ts` fora: `actions.ts` é Server Action, cada uma é uma requisição
      //   própria e a ordem das escritas costuma ser exigida pelo domínio.
      //
      // Foi `components/shell.tsx` que mostrou por que `page.tsx` não bastava:
      // ele tinha TRÊS leituras em fila e embrulha toda página autenticada.
      if (!/^\s*["']use client["']/m.test(readFileSync(caminho, "utf8"))) {
        saida.push(caminho);
      }
    }
  }

  return saida;
}

/** Nomes que uma desestruturação (ou um identificador simples) liga. */
function nomesLigados(alvo) {
  if (!alvo.startsWith("{") && !alvo.startsWith("[")) return [alvo];

  const saida = [];

  for (const parte of alvo.slice(1, -1).split(",")) {
    const limpo = parte.trim().split(":").pop()?.trim().replace(/^\.+/, "");
    const nome = /^[A-Za-z_$][\w$]*/.exec(limpo ?? "");

    if (nome !== null) saida.push(nome[0]);
  }

  return saida;
}

/**
 * Profundidade de bloco em que a posição está, contando SÓ os blocos abertos
 * por `if`/`else`/`for`/`while`/`switch` — um `await` dentro de um deles é
 * condicional, e condicional é o padrão certo.
 */
function dentroDeCondicional(fonte, posicao) {
  const antes = fonte.slice(0, posicao);
  const pilha = [];
  let i = 0;

  while (i < antes.length) {
    const c = antes[i];

    if (c === "{") {
      // Olha para trás o suficiente para reconhecer o cabeçalho do bloco.
      const cabeca = antes.slice(Math.max(0, i - 400), i);
      pilha.push(/\b(?:if|else|for|while|switch|catch)\b[^{};]*$/.test(cabeca));
    } else if (c === "}") {
      pilha.pop();
    }

    i += 1;
  }

  return pilha.some(Boolean);
}

const DECL = /(?:const|let)\s+(\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);\n/g;
const LEITURA = /^await\s+supabase\b/;
const BARREIRA = /^await\s+Promise\.all\b/;

/** Achados de um arquivo: leituras em fila que não usam nada da anterior. */
export function analisar(fonte) {
  const achados = [];

  // Uma FUNÇÃO por vez. Duas funções no mesmo arquivo não estão em fila uma
  // com a outra, e tratar o arquivo como um bloco só produzia acusação falsa
  // — foi o que a primeira execução deste guarda fez, em cima de `actions.ts`.
  for (const pedaco of pedacosDeFuncao(fonte)) {
    achados.push(...analisarFuncao(fonte, pedaco.inicio, pedaco.texto));
  }

  return achados;
}

/** Fatia a fonte nos limites de `function`, guardando o deslocamento. */
function pedacosDeFuncao(fonte) {
  const inicios = [...fonte.matchAll(/\bfunction\b/g)].map((m) => m.index);

  if (inicios.length === 0) return [{ inicio: 0, texto: fonte }];

  return inicios.map((inicio, i) => ({
    inicio,
    texto: fonte.slice(inicio, inicios[i + 1] ?? fonte.length),
  }));
}

function analisarFuncao(fonteInteira, deslocamento, fonte) {
  const contaminados = new Set();
  const achados = [];
  let jaHouveLeitura = false;

  for (const m of fonte.matchAll(DECL)) {
    const alvo = m[1];
    const expressao = m[2].trim();
    const usados = [...contaminados].filter((n) => new RegExp(`\\b${n}\\b`).test(expressao));

    if (LEITURA.test(expressao) || BARREIRA.test(expressao)) {
      const linha = fonteInteira.slice(0, deslocamento + m.index).split("\n").length;
      const anterior = fonte.slice(0, m.index).split("\n").slice(-3).join("\n");

      if (
        LEITURA.test(expressao) &&
        jaHouveLeitura &&
        usados.length === 0 &&
        !ESCAPE.test(anterior) &&
        !dentroDeCondicional(fonte, m.index)
      ) {
        achados.push({ linha, trecho: expressao.split("\n")[0].slice(0, 72) });
      }

      jaHouveLeitura = true;

      for (const nome of nomesLigados(alvo)) contaminados.add(nome);
    } else if (usados.length > 0) {
      // Derivada de leitura: passa a contaminar, senão a dependência some.
      for (const nome of nomesLigados(alvo)) contaminados.add(nome);
    }
  }

  return achados;
}

// ---------------------------------------------------------------------------
// O detector se prova antes de julgar o repo.
//
// Um guarda que para de detectar em silêncio é pior do que guarda nenhum: a
// esteira fica verde e a garantia sumiu. Estes três casos custam
// milissegundos e falham alto se a regex quebrar numa manutenção.
// ---------------------------------------------------------------------------
const CASOS = [
  {
    nome: "acusa duas leituras independentes em fila",
    fonte: `
  const membership = await supabase.from("organization_members").select("role").maybeSingle();
  const rows = await supabase.from("feature_suggestions").select("id");
`,
    esperado: 1,
  },
  {
    nome: "não acusa quando a segunda usa a primeira",
    fonte: `
  const membership = await supabase.from("organization_members").select("organization_id").maybeSingle();
  const organizationId = membership.data?.organization_id ?? null;
  const rows = await supabase.rpc("get_stock_balances", { p_organization_id: organizationId });
`,
    esperado: 0,
  },
  {
    // O caso que mais preocupa numa regressão: a página já tem `Promise.all`,
    // parece arrumada, e alguém pendura mais uma leitura solta embaixo.
    nome: "acusa leitura solta depois de um Promise.all",
    fonte: `
  const [a, b] = await Promise.all([supabase.from("x").select("id"), supabase.from("y").select("id")]);
  const c = await supabase.from("z").select("id");
`,
    esperado: 1,
  },
  {
    nome: "não acusa leitura condicional",
    fonte: `
  const caseRow = await supabase.from("support_cases").select("id").maybeSingle();
  if (podeResponder) {
    const templates = await supabase.from("reply_templates").select("id");
  }
`,
    esperado: 0,
  },
];

for (const caso of CASOS) {
  const obtido = analisar(caso.fonte).length;

  if (obtido !== caso.esperado) {
    console.error(`check:waterfalls — o próprio detector falhou: ${caso.nome}`);
    console.error(`  esperava ${caso.esperado} achado(s), obteve ${obtido}`);
    process.exit(1);
  }
}

const paginas = RAIZES.flatMap((raiz) => arquivos(raiz));
const problemas = [];

for (const caminho of paginas) {
  for (const achado of analisar(readFileSync(caminho, "utf8"))) {
    problemas.push({ caminho, ...achado });
  }
}

if (problemas.length > 0) {
  console.error(`check:waterfalls — ${problemas.length} leitura(s) em fila sem dependência:\n`);

  for (const p of problemas) {
    console.error(`  ${p.caminho}:${p.linha}`);
    console.error(`    ${p.trecho}`);
  }

  console.error(`
Cada uma custa uma ida ao banco somada à anterior, antes da página renderizar.
Junte-as em \`Promise.all([...])\`, ou — se a ordem for necessária por um
motivo que não é dependência de dado — escreva \`// fila-justificada: <razão>\`
na linha de cima.`);
  process.exit(1);
}

console.log(`check:waterfalls ok — ${paginas.length} arquivos, nenhuma leitura em fila sem dependência.`);
