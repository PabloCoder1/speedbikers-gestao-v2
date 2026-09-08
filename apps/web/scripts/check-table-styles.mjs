/**
 * Procura tela que declara `.sb-table` e MESMO ASSIM mantém a tipografia de
 * célula do sistema antigo.
 *
 * **Por que existe.** A frente visual migra as telas uma a uma, e o movimento
 * de cada migração é o mesmo: a `<table>` ganha `className="sb-table"` e os
 * `const td` / `const tdNumber` do arquivo saem, porque a classe passa a ser
 * dona do padding, da borda, do tamanho e do alinhamento numérico.
 *
 * O modo de falhar é migrar pela METADE — pôr a classe e apagar só parte dos
 * `style={td}`. O arquivo fica com dois donos do mesmo pixel, e o inline vence
 * o da classe. `build` passa, `typecheck` passa, `lint` passa, a tela abre. É a
 * classe D-131: não quebra, MENTE — e mente justamente sobre a coisa que a
 * fatia dizia ter feito.
 *
 * **Achado na auditoria A3b**, quando duas telas que a tabela de progresso já
 * dava por migradas ainda tinham a tipografia paralela viva:
 *
 *   - `/estoque/movimentacoes` — `const th`/`td`/`tdNumber` intactos sob uma
 *     `<table className="sb-table">`.
 *   - `/reposicao` — pior: **23 células** com `style={td}` sobrepondo a classe
 *     que o próprio arquivo declarava, quatro fatias depois da migração.
 *
 * Dois commits afirmaram "legado removido" enquanto isso estava no disco. O
 * defeito não é o inline: é ninguém ter como VER a meia-migração sem abrir
 * arquivo por arquivo. Enquanto restarem telas por migrar, o modo de falhar
 * segue disponível — é para elas que este guarda existe.
 *
 * **O que ele NÃO pega**, dito para ninguém confundir silêncio com garantia:
 *
 *   - **Tela ainda não migrada** (sem `sb-table`). De propósito: lá o `const
 *     td` é o sistema antigo INTEIRO e coerente, correto onde a frente visual
 *     não chegou. Reprovar isso seria transformar 22 telas legítimas em ruído,
 *     e guarda que berra por nada é como um sinal de verdade fica silenciado.
 *   - **`<td style={{ color: saldo < 0 ? "var(--sb-danger)" : undefined }}>`.**
 *     Cor que depende do DADO não é tipografia paralela: nenhuma classe
 *     estática a expressa. São 96 no repositório, todas em token — medido: zero
 *     hex e zero px cru em célula, em qualquer tela.
 *   - Um objeto de estilo com outro nome, ou importado sob outro nome.
 *   - **A migração que nunca começou.** É metade do achado do A3b e o guarda é
 *     cego para ela: `/estoque/movimentacoes` não tinha `sb-table` NENHUMA — o
 *     commit de D-252 afirmou "legado removido" e não removeu nada. Sem a
 *     classe declarada não há contradição no arquivo, e do lado de fora essa
 *     tela é indistinguível de uma que ainda não chegou na fila. Quem sabe a
 *     diferença é a tabela de progresso do doc, que é prosa e não dá para ler
 *     por regex sem inventar precisão. Essa metade continua sendo pega pela
 *     captura do A3 — abrir a tela —, e é por isso que o A3 existe como rotina.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RAIZES = ["app"];

/**
 * Declaração da tipografia paralela: `const td: React.CSSProperties = {`.
 *
 * A lista de nomes é FECHADA — o guarda mira o padrão real desta casa, não
 * qualquer objeto de estilo que alguém venha a declarar. Vai do mais longo para
 * o mais curto para `td` não sombrear `tdNumber`.
 *
 * Escrita como LITERAL de propósito. A alternativa (`new RegExp` com string)
 * exige barra dupla, e a barra dupla não sobreviveu à camada de escape por onde
 * este arquivo foi escrito: a regex nasceu `^s*consts+`, casando com nada. Quem
 * pegou foi o auto-teste lá embaixo, e é exatamente para isso que ele existe.
 */
const DECLARACAO = /^\s*const\s+(tdNumber|thNumber|tdNumero|cell|th|td)\b\s*[:=]/gm;

/**
 * USO da tipografia paralela numa célula: `<td style={td}>`.
 *
 * É o `style={NOME}` que importa, não `style={{...}}` — a chave dupla é objeto
 * literal, e o caso legítimo (cor dependente do dado) mora todo lá.
 */
const USO = /<t[dh][^>]*style=\{(tdNumber|thNumber|tdNumero|cell|th|td)\b/g;

/** A tela declarou que migrou para o design system. */
const MIGRADA = /sb-table/;

function analisar(texto) {
  if (!MIGRADA.test(texto)) return null;

  const declaracoes = [...texto.matchAll(DECLARACAO)].map((m) => m[1]);
  const usos = [...texto.matchAll(USO)].length;

  if (declaracoes.length === 0 && usos === 0) return null;

  return { declaracoes, usos };
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
// Os dois casos que mais importam aqui são os NEGATIVOS: uma tela não migrada e
// uma cor dependente do dado. Se o guarda passar a acusar qualquer um dos dois,
// vira ruído — e ruído é como a acusação verdadeira deixa de ser lida.
// ---------------------------------------------------------------------------
const CASOS = [
  {
    nome: "acusa a classe declarada com a tipografia paralela viva",
    fonte: `
      const td: React.CSSProperties = { padding: "0.5rem", borderBottom: "1px solid var(--sb-border)" };
      export default function P() { return <table className="sb-table"><td style={td}>x</td></table>; }
    `,
    acusa: true,
  },
  {
    nome: "acusa o USO sobrevivente mesmo sem a declaração no arquivo",
    fonte: `
      import { td } from "./estilos";
      export default function P() { return <table className="sb-table"><td style={td}>x</td></table>; }
    `,
    acusa: true,
  },
  {
    nome: "tela migrada e limpa passa",
    fonte: `
      export default function P() { return <table className="sb-table"><td className="sb-num">1</td></table>; }
    `,
    acusa: false,
  },
  {
    // O falso positivo mais caro: 22 telas do repo estão exatamente assim hoje.
    nome: "tela AINDA NAO migrada nao e acusada",
    fonte: `
      const td: React.CSSProperties = { padding: "0.5rem" };
      export default function P() { return <table><td style={td}>x</td></table>; }
    `,
    acusa: false,
  },
  {
    // O segundo falso positivo caro: são 96 no repo, todos legítimos.
    nome: "cor dependente do dado nao e tipografia paralela",
    fonte: `
      export default function P() {
        return <table className="sb-table"><td className="sb-num" style={{ color: n < 0 ? "var(--sb-danger)" : undefined }}>{n}</td></table>;
      }
    `,
    acusa: false,
  },
];

for (const caso of CASOS) {
  const acusou = analisar(caso.fonte) !== null;

  if (acusou !== caso.acusa) {
    console.error(`check:table-styles — AUTO-TESTE FALHOU: "${caso.nome}"`);
    console.error(`  esperado ${caso.acusa ? "acusar" : "passar"}, o detector ${acusou ? "acusou" : "passou"}.`);
    console.error(`
A varredura não vale nada com a detecção quebrada: ela ficaria VERDE sem
detectar. Conserte a expressão antes de confiar no resultado desta esteira.`);
    process.exit(1);
  }
}

const problemas = [];
let migradas = 0;

for (const raiz of RAIZES) {
  let lista;

  try {
    lista = arquivos(raiz);
  } catch {
    continue;
  }

  for (const caminho of lista) {
    const texto = readFileSync(caminho, "utf8");

    if (!MIGRADA.test(texto)) continue;

    migradas += 1;

    const achado = analisar(texto);

    if (achado !== null) problemas.push({ caminho, ...achado });
  }
}

if (problemas.length > 0) {
  console.error(`check:table-styles — ${problemas.length} tela(s) com .sb-table e a tipografia de célula antiga viva:\n`);

  for (const p of problemas) {
    const decl = p.declaracoes.length > 0 ? `declara ${p.declaracoes.join(", ")}` : "sem declaração local";

    console.error(`  ${p.caminho}  (${decl}; ${String(p.usos)} célula(s) com style={...})`);
  }

  console.error(`
A classe e o inline são dois donos do mesmo pixel, e o inline vence — a tela não
se parece com o que a migração diz ter feito, com a esteira verde.

Apague o objeto de estilo e mova cada célula para as classes: .sb-table no
<table>, .sb-num na coluna numérica, .sb-mono no código. Cor que depende do DADO
continua inline, em token — essa não é o alvo.`);
  process.exit(1);
}

console.log(`check:table-styles ok — ${String(migradas)} tela(s) com .sb-table, nenhuma com a tipografia de célula antiga.`);
