/**
 * Procura CAMPO e BOTÃO fora do design system.
 *
 * **Por que existe.** O export do Figma tem UMA forma de botão (`.button`:
 * 32px, 11px, raio 6px) e uma de campo. A V3 tem as duas em `app/globals.css`
 * — `.sb-button` e `.sb-input` — e mesmo assim a auditoria A4 (D-283)
 * fotografou **59 campos em 29 arquivos** e **59 botões em 35** com estilo
 * inline, incluindo **quatro cópias** de um `const buttonStyle` com raio 8px e
 * 12px. Na Base de Conhecimento isso aparecia como um botão nativo do sistema
 * operacional logo abaixo de um painel migrado.
 *
 * O motivo de ter voltado é estrutural, e é a razão deste arquivo existir:
 * `check:table-styles` guarda a TABELA (D-262), e a tabela parou de divergir.
 * Campo e botão não tinham guarda — e o padrão volta quando não há quem o
 * reprove.
 *
 * **Ele pega as DUAS metades desde o passo cinza (D-285).** A primeira versão
 * media só a ausência da classe, e escreveu aqui que a disputa dentro do
 * elemento que já a tem ficava de fora. Ficou por pouco tempo: o passo cinza
 * mediu **26 elementos com a classe E aparência inline** — `background:
 * "transparent"` num `.sb-button`, que sobre chão branco é branco e sobre chão
 * cinza vira um botão cinza dentro de um cartão branco. O que era invisível
 * passou a ser visível no dia em que o chão mudou.
 *
 * **O que ele NÃO pega**, dito para ninguém confundir silêncio com garantia:
 *
 *   - **um controle desenhado com `<div role="button">`** — não existe no
 *     repositório hoje (medido), e reprovar `div` por precaução acusaria a
 *     tela inteira;
 *   - **CSS novo que reinvente a forma** (`.minha-caixa` com padding e borda).
 *     Isso é uma classe, não inline, e a revisão de código é quem pega.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RAIZES = ["app", "components"];

/** As classes que JÁ são forma de controle no design system. */
const CLASSES = [
  "sb-button",
  "sb-input",
  "sb-menu-item",
  "sb-close",
  "sb-text-button",
  "sb-nav-link",
  "sb-nav-label",
  "sb-icon-button",
  "sb-command-row",
  "sb-command-input",
  "sb-command-field",
  "sb-inbox-filter",
  "sb-diagnostic-item",
  "sb-menu-remove",
  "sb-segmented",
  "sb-kpi-link",
  "sb-state-card",
  "sb-attention-cta",
  "sb-abc-card",
  "sb-process-step",
  "sb-split-item",
  "sb-profile",
  "sb-search",
  "sb-account",
  "sb-brand",
  "sb-help",
];

/**
 * As propriedades que a CLASSE manda. `color` não está aqui de propósito: cor
 * que depende do dado é legítima e nenhuma classe estática a expressa — mesma
 * exceção que `check:table-styles` abre para a célula pintada por valor.
 */
const APARENCIA = [
  "padding",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingBottom",
  "border",
  "borderRadius",
  "borderColor",
  "background",
  "backgroundColor",
  "fontSize",
  "fontWeight",
  "fontFamily",
  "cursor",
  "opacity",
];

/** Campos que não têm forma: a caixa e o rádio desenham a si mesmos. */
const SEM_FORMA = /type="(checkbox|radio|hidden)"/;

/**
 * Acha o `>` que FECHA a tag, e não o primeiro que aparecer.
 *
 * `<button ... onClick={() => {…}}>` tem um `>` dentro da seta, e uma regex
 * `[^>]*?` para nele. **Foi exatamente esse o defeito que o passe A5 cometeu**:
 * a classe entrou e o `style={buttonStyle}` que vinha depois do `onClick`
 * sobreviveu, deixando os dois donos do mesmo pixel no mesmo elemento. O
 * scanner conta chaves e ignora o que está dentro de string.
 */
function fimDaTag(texto, inicio) {
  let chaves = 0;
  let aspas = null;

  for (let i = inicio; i < texto.length; i += 1) {
    const c = texto[i];

    if (aspas !== null) {
      if (c === aspas && texto[i - 1] !== "\\") aspas = null;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      aspas = c;
      continue;
    }

    if (c === "{") chaves += 1;
    else if (c === "}") chaves -= 1;
    else if (c === ">" && chaves === 0) return i;
  }

  return -1;
}

/**
 * Comentário não é interface.
 *
 * O PRIMEIRO resultado desta varredura acusou a palavra `<button>` dentro do
 * docstring de `filter-pill.tsx` — um guarda que lê prosa como se fosse JSX
 * acusa por nada, e guarda que berra por nada é como a acusação verdadeira
 * deixa de ser lida. Os blocos `/* … *\/` somem antes da leitura; as linhas
 * `//` ficam, porque não carregam JSX nesta casa e apagá-las por regex
 * mutilaria URL dentro de string.
 */
function semComentarios(texto) {
  return texto.replace(/\/\*[\s\S]*?\*\//g, "");
}

function controles(bruto) {
  const texto = semComentarios(bruto);
  const achados = [];

  for (const m of texto.matchAll(/<(button|input|select|textarea)\b/g)) {
    const fim = fimDaTag(texto, m.index);

    if (fim === -1) continue;

    const tag = texto.slice(m.index, fim + 1);

    if (SEM_FORMA.test(tag)) continue;

    const linha = texto.slice(0, m.index).split("\n").length;

    if (!CLASSES.some((c) => tag.includes(c))) {
      achados.push({ tag: m[1], linha, motivo: "sem classe" });
      continue;
    }

    /*
      A SEGUNDA METADE: tem a classe e declara aparência ao lado dela.

      `color` fica de fora da lista porque cor que depende do DADO é legítima e
      nenhuma classe estática a expressa — é a mesma exceção que
      `check:table-styles` abre para a célula pintada por valor. O resto
      (padding, borda, fundo, fonte) a classe já manda, e o inline vence.
    */
    /*
      TINTA BRANCA SEM A VARIANTE QUE A SUSTENTA (D-287).

      `color` fica fora da lista de aparência porque cor depende do dado — mas
      `var(--sb-white)` num `.sb-button` sem `-primary`/`-danger` é branco sobre
      branco, ou seja, **botão invisível**. Não é hipótese: o passo cinza tirou o
      `background` de sete botões (a classe manda nele) e deixou a tinta, e o
      "Perguntar" do Copiloto sumiu da tela. Nenhum teste viu; a captura viu.
    */
    if (/color:\s*[^,}]*var\(--sb-white\)/.test(tag) && !/sb-button-(primary|danger)/.test(tag)) {
      achados.push({ tag: m[1], linha, motivo: "tinta branca sem variante que a sustente" });
      continue;
    }

    const literal = /style=\{\{([\s\S]*?)\}\}/.exec(tag);

    if (literal !== null) {
      const disputa = APARENCIA.filter((prop) => new RegExp(`(^|[{,\\s])${prop}\\s*:`).test(literal[1]));

      if (disputa.length > 0) {
        achados.push({ tag: m[1], linha, motivo: `inline: ${disputa.join(", ")}` });
      }

      continue;
    }

    /*
      E a MESMA disputa por REFERÊNCIA: `style={fieldStyle}`.

      Três formulários declaravam um objeto com padding, borda e
      `background: "transparent"` e o aplicavam ao lado da classe. Sobre chão
      branco isso é invisível; sobre o chão cinza vira campo cinza dentro de
      cartão branco. O guarda procura a declaração no MESMO arquivo — objeto
      importado de outro módulo continua fora do alcance, e isso fica dito para
      ninguém confundir silêncio com garantia.
    */
    const referencia = /style=\{([A-Za-z_$][\w$]*)\}/.exec(tag);

    if (referencia === null) continue;

    const decl = new RegExp(`const ${referencia[1]}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(texto);

    if (decl === null) continue;

    const disputa = APARENCIA.filter((prop) => new RegExp(`(^|[{,\\s])${prop}\\s*:`).test(decl[1]));

    if (disputa.length > 0) {
      achados.push({ tag: m[1], linha, motivo: `style={${referencia[1]}}: ${disputa.join(", ")}` });
    }
  }

  return achados;
}

function arquivos(dir) {
  const saida = [];

  for (const entrada of readdirSync(dir)) {
    const caminho = join(dir, entrada);

    if (statSync(caminho).isDirectory()) {
      if (entrada === "node_modules" || entrada === ".next") continue;
      saida.push(...arquivos(caminho));
      continue;
    }

    if (entrada.endsWith(".tsx")) saida.push(caminho);
  }

  return saida;
}

// ---------------------------------------------------------------------------
// O detector se prova antes de julgar o repo.
//
// O caso do `=>` está aqui porque ele NÃO é hipotético: foi o defeito real do
// passe que criou este guarda. Um scanner que pare no primeiro `>` acha a
// classe que veio antes da seta e passa por cima do estilo que veio depois.
// ---------------------------------------------------------------------------
const CASOS = [
  {
    nome: "botao sem classe e acusado",
    fonte: `<button type="button" onClick={() => { go(); }}>Ir</button>`,
    acusa: 1,
  },
  {
    nome: "botao com a classe passa",
    fonte: `<button className="sb-button" type="button" onClick={() => { go(); }}>Ir</button>`,
    acusa: 0,
  },
  {
    nome: "a seta do onClick NAO fecha a tag",
    // Sem o scanner de chaves, a classe daqui seria lida como ausente.
    fonte: `<button\n  type="button"\n  onClick={() => { go(); }}\n  className="sb-button"\n>Ir</button>`,
    acusa: 0,
  },
  {
    nome: "campo sem classe e acusado",
    fonte: `<input type="text" value={x} onChange={(e) => { set(e.target.value); }} />`,
    acusa: 1,
  },
  {
    nome: "checkbox nao tem forma e passa",
    fonte: `<input type="checkbox" checked={x} onChange={() => { alternar(); }} />`,
    acusa: 0,
  },
  {
    // O primeiro falso positivo real desta varredura.
    nome: "a palavra <button> dentro de comentario nao e interface",
    fonte: `/** O gemeo em <button> do FilterPill. */
export function X() { return null; }`,
    acusa: 0,
  },
  {
    // A segunda metade, medida no passo cinza: 26 elementos assim.
    nome: "classe E aparencia inline sao dois donos do mesmo pixel",
    fonte: `<button className="sb-button" type="button" style={{ background: "transparent", padding: "0.25rem" }}>Ir</button>`,
    acusa: 1,
  },
  {
    nome: "tinta branca sem primary e botao invisivel",
    fonte: `<button className="sb-button" type="button" style={{ color: "var(--sb-white)" }}>Ir</button>`,
    acusa: 1,
  },
  {
    nome: "tinta branca COM primary passa",
    fonte: `<button className="sb-button sb-button-primary" type="button" style={{ color: "var(--sb-white)" }}>Ir</button>`,
    acusa: 0,
  },
  {
    nome: "cor que depende do dado NAO e aparencia paralela",
    fonte: `<button className="sb-button" type="button" style={{ color: "var(--sb-danger)" }}>Cancelar</button>`,
    acusa: 0,
  },
  {
    // O buraco que a primeira versão da segunda metade deixou: três
    // formulários aplicavam a aparência por referência, não por literal.
    nome: "aparencia por REFERENCIA tambem e disputa",
    fonte: `const fieldStyle = {\n  padding: "0.375rem",\n  background: "transparent",\n};\n<input className="sb-input" style={fieldStyle} />`,
    acusa: 1,
  },
  {
    nome: "layout ao lado da classe passa",
    fonte: `<input className="sb-input" type="search" style={{ minWidth: "12rem" }} />`,
    acusa: 0,
  },
  {
    nome: "outro componente do design system passa",
    fonte: `<button className="sb-menu-item" type="button" onClick={() => { pick(); }}>Escolher</button>`,
    acusa: 0,
  },
];

for (const caso of CASOS) {
  const achou = controles(caso.fonte).length;

  if (achou !== caso.acusa) {
    console.error(`check:control-styles — AUTO-TESTE FALHOU: "${caso.nome}"`);
    console.error(`  esperado ${String(caso.acusa)} acusação(ões), o detector achou ${String(achou)}.`);
    console.error(`
A varredura não vale nada com a detecção quebrada: ela ficaria VERDE sem
detectar. Conserte o scanner antes de confiar no resultado desta esteira.`);
    process.exit(1);
  }
}

const problemas = [];
let total = 0;

for (const raiz of RAIZES) {
  let lista;

  try {
    lista = arquivos(raiz);
  } catch {
    continue;
  }

  for (const caminho of lista) {
    const texto = readFileSync(caminho, "utf8");
    const achados = controles(texto);

    total += (semComentarios(texto).match(/<(button|input|select|textarea)\b/g) ?? []).length;

    if (achados.length > 0) problemas.push({ caminho, achados });
  }
}

if (problemas.length > 0) {
  const quantos = problemas.reduce((soma, p) => soma + p.achados.length, 0);

  console.error(`check:control-styles — ${String(quantos)} controle(s) fora do design system, em ${String(problemas.length)} arquivo(s):\n`);

  for (const p of problemas) {
    const onde = p.achados.map((a) => `${a.tag}:${String(a.linha)} (${a.motivo})`).join(", ");

    console.error(`  ${p.caminho}  (${onde})`);
  }

  console.error(`
Campo é \`.sb-input\`; botão é \`.sb-button\` (com \`.sb-button-primary\` na ação
principal e \`.sb-button-sm\` dentro de cartão). O Figma tem UMA forma de cada, e
estilo inline ao lado da classe é a migração pela metade que A4 fotografou.

Caixa e rádio desenham a si mesmos e não entram. Se o controle é de outra
família do design system (item de menu, fechar, ação em texto), use a classe
dela — o guarda conhece todas.`);
  process.exit(1);
}

console.log(`check:control-styles ok — ${String(total)} controle(s), todos com a forma do design system.`);
