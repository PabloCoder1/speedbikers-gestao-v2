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
 * **Três furos que D-197 fechou**, todos achados por uma varredura de agentes
 * que leu o código em vez de casar regex:
 *
 * - um `await Promise.all([...])` era tratado só como MARCO, nunca perguntando
 *   se o bloco inteiro dependia da leitura anterior. `/compras/[id]` lia o
 *   pedido, e só então disparava um `Promise.all` de itens e eventos que não
 *   usava nada dele;
 * - uma consulta montada numa variável (`let q = supabase.from(...)`, depois
 *   `await q.range(...)`) não era reconhecida como leitura, porque a expressão
 *   não começa em `await supabase`. Era o caso de `/importacoes/[id]`;
 * - o guarda passou a varrer `components/` junto com `app/`, e não só
 *   `page.tsx` — foi assim que `shell.tsx` apareceu (D-195).
 *
 * **Dois limites que ele NÃO tem como fechar, ditos aqui para ninguém
 * confundir silêncio com garantia:**
 *
 * - **dependência textual inventada por filtro redundante.** `/precos` e
 *   `/full` liam `ml_accounts` com `.eq("organization_id", organizationId)`,
 *   e esse `organizationId` — vindo da leitura anterior — fazia o guarda
 *   classificar a leitura como dependente. Só que a RLS de `ml_accounts` já
 *   restringe por organização E por permissão de conta: o filtro não removia
 *   linha nenhuma, só criava a fila. Saber isso exige conhecer a RLS, que um
 *   leitor estático não conhece;
 * - **leituras em `if` irmãos com a mesma condição.** `/diagnostico` tinha
 *   dois `if (candidateSkuIds.length > 0)` seguidos, um com cada leitura.
 *   Cada um é condicional — e leitura condicional é o padrão certo — mas
 *   juntos são uma fila. O guarda não funde blocos.
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

/**
 * O nome é MESMO usado nesta expressão — ou é o método homônimo?
 *
 * O `(?<!\.)` não é preciosismo. Uma variável chamada `order` colide com
 * `.order("position")`, que aparece em quase toda leitura do PostgREST: sem o
 * lookbehind, o guarda lia `.order(` dentro do bloco de `/compras/[id]`,
 * concluía que ele dependia da variável `order`, e a página passava VERDE com
 * o waterfall intacto.
 *
 * Um falso NEGATIVO é o pior defeito possível aqui, porque a esteira fica
 * verde e a garantia sumiu sem ninguém perceber. Este foi encontrado ao rodar
 * o guarda contra o código ANTERIOR à correção — que é exatamente para isso
 * que essa conferência existe (D-197).
 *
 * A segunda alternativa (`(?<=\.\.\.)`) existe porque o SPREAD também começa
 * com ponto: `{ ...filtro }` é uso legítimo da variável, não acesso a membro.
 * Foi o auto-teste desta mesma varredura que pegou isso, na primeira versão
 * do lookbehind — o caso da declaração anotada passou a acusar `/vendas` de
 * novo. Guarda que se prova antes de julgar não é cerimônia.
 */
function nomeUsadoEm(nome, expressao) {
  return new RegExp(`(?:(?<![.\\w$])|(?<=\\.\\.\\.))\\b${nome}\\b`).test(expressao);
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

// `(?::[^=;]+)?` é a ANOTAÇÃO DE TIPO, e ela não é detalhe: sem tolerá-la,
// `const accounts: AccountOption[] = accountsResult.data ?? []` não casava,
// `accounts` nunca era marcado como derivado da leitura, e a dependência
// sumia três níveis adiante — o guarda então ACUSAVA `/vendas`, que estava
// certa. Um falso positivo custa mais caro que um achado perdido: ele ensina
// a ignorar o guarda.
const DECL = /(?:const|let)\s+(\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*)(?::[^=;]+)?\s*=\s*([\s\S]*?);\n/g;
// Reatribuição: `casesQuery = casesQuery.eq("ml_account_id", selectedAccount.id)`.
// É assim que uma consulta montada ganha filtros vindos de uma leitura
// anterior, e ignorá-la fazia o guarda acusar `/atendimento` sem razão.
const REATRIB = /^[ \t]*([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);\n/gm;
const LEITURA = /^await\s+supabase\b/;
const BARREIRA = /^await\s+Promise\.all\b/;
// Consulta MONTADA numa variável, sem `await`: `let q = supabase.from(...)`.
// Montar não dispara nada; o `await` depois é que é a leitura.
const MONTAGEM = /^supabase\s*[.\n]/;

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
  // Nomes que carregam DADO vindo de uma leitura. Uma leitura que menciona
  // qualquer um deles depende da anterior.
  const contaminados = new Set();
  // Nomes que carregam uma CONSULTA MONTADA, ainda não disparada. Eles NÃO
  // contaminam — montar não é ler —, mas `await <nome>` é uma leitura.
  const montadas = new Set();
  const achados = [];
  let jaHouveLeitura = false;

  // Declarações e reatribuições, na ORDEM do arquivo: a contaminação é
  // sequencial, e ler as duas listas separadamente perderia a ordem.
  const eventos = [
    ...[...fonte.matchAll(DECL)].map((m) => ({ i: m.index, alvo: m[1], expr: m[2], decl: true })),
    ...[...fonte.matchAll(REATRIB)].map((m) => ({ i: m.index, alvo: m[1], expr: m[2], decl: false })),
  ].sort((a, b) => a.i - b.i);

  for (const m of eventos) {
    const alvo = m.alvo;
    const expressao = m.expr.trim();
    const usados = [...contaminados].filter((n) => nomeUsadoEm(n, expressao));

    // Uma reatribuição nunca é leitura: `q = q.eq(...)` só monta. Ela serve
    // para PROPAGAR contaminação para a consulta montada.
    if (!m.decl) {
      if (usados.length > 0) {
        contaminados.add(alvo);
        montadas.delete(alvo);
      }
      continue;
    }

    const leituraMontada = [...montadas].some((n) => new RegExp(`^await\\s+${n}\\b`).test(expressao));
    const eLeitura = LEITURA.test(expressao) || leituraMontada;
    const eBarreira = BARREIRA.test(expressao);

    if (eLeitura || eBarreira) {
      const linha = fonteInteira.slice(0, deslocamento + m.i).split("\n").length;
      const anterior = fonte.slice(0, m.i).split("\n").slice(-3).join("\n");

      // A BARREIRA também é julgada, e não só contada. Um `Promise.all` que
      // não usa nada da leitura anterior é exatamente o mesmo defeito: o
      // bloco inteiro espera por um dado que não consome.
      if (
        jaHouveLeitura &&
        usados.length === 0 &&
        !ESCAPE.test(anterior) &&
        !dentroDeCondicional(fonte, m.i)
      ) {
        achados.push({ linha, trecho: expressao.split("\n")[0].slice(0, 72) });
      }

      jaHouveLeitura = true;

      for (const nome of nomesLigados(alvo)) contaminados.add(nome);
    } else if (MONTAGEM.test(expressao)) {
      for (const nome of nomesLigados(alvo)) montadas.add(nome);
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
    // D-197: o `Promise.all` deixou de ser so um marco.
    nome: "acusa um Promise.all que nao usa nada da leitura anterior",
    fonte: `
  const pedido = await supabase.from("purchase_orders").select("id").eq("id", id).maybeSingle();
  const [itens, eventos] = await Promise.all([
    supabase.from("purchase_order_items").select("id").eq("purchase_order_id", id),
    supabase.from("purchase_order_events").select("id").eq("purchase_order_id", id),
  ]);
`,
    esperado: 1,
  },
  {
    nome: "nao acusa um Promise.all que USA a leitura anterior",
    fonte: `
  const membership = await supabase.from("organization_members").select("organization_id").maybeSingle();
  const organizationId = membership.data?.organization_id ?? null;
  const [a, b] = await Promise.all([
    supabase.rpc("x", { p_organization_id: organizationId }),
    supabase.rpc("y", { p_organization_id: organizationId }),
  ]);
`,
    esperado: 0,
  },
  {
    // D-197: consulta montada numa variavel e depois disparada.
    nome: "acusa leitura disparada de uma consulta montada antes",
    fonte: `
  const lote = await supabase.from("erp_import_batches").select("id").eq("id", id).maybeSingle();
  let rowsQuery = supabase.from("erp_import_rows").select("row_number").eq("batch_id", id);
  const linhas = await rowsQuery.order("row_number").range(0, 49);
`,
    esperado: 1,
  },
  {
    // D-197: a anotacao de tipo nao pode cortar a cadeia de dependencia.
    nome: "nao acusa quando a dependencia passa por declaracao ANOTADA",
    fonte: `
  const contas = await supabase.from("ml_accounts").select("id, slug");
  const lista: AccountOption[] = contas.data ?? [];
  const escolhida = lista.find((c) => c.slug === slug) ?? null;
  const filtro = escolhida === null ? {} : { p_ml_account_id: escolhida.id };
  const [a, b] = await Promise.all([
    supabase.rpc("get_sales_summary", { ...filtro }),
    supabase.rpc("get_sales_series", { ...filtro }),
  ]);
`,
    esperado: 0,
  },
  {
    // D-197: a consulta ganha o filtro por REATRIBUICAO, dentro de um if.
    nome: "nao acusa consulta montada que recebe filtro da leitura anterior",
    fonte: `
  const contas = await supabase.from("ml_accounts").select("id, slug");
  const escolhida = (contas.data ?? []).find((c) => c.slug === slug) ?? null;
  let casesQuery = supabase.from("support_cases").select("id");
  if (escolhida !== null) {
    casesQuery = casesQuery.eq("ml_account_id", escolhida.id);
  }
  const casos = await casesQuery;
`,
    esperado: 0,
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
