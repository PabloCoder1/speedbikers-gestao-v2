/**
 * O ELEMENTO DE UMA MÉTRICA, PELA FORMA E NUNCA PELO CONTEÚDO (D-516).
 *
 * O reporter de produção (`app/web-vitals.tsx`) mandava só nome, valor, rota e
 * `softNav`. Na leitura de 19/10, a Home teve LCP de 6,3 e 10,3 s, e o log não
 * dizia se era a faixa e o gráfico (primeira rodada) ou a "Atenção necessária"
 * (segunda) — a D-514 só soube porque mediu no build local. Agora o LCP e o
 * maior deslocamento do CLS levam o elemento: a tag, as classes do design
 * system (`sb-*`, que vêm do código) e a seção em que ele mora, pela POSIÇÃO
 * entre as seções do conteúdo.
 *
 * Nada de texto, `id` ou `aria-label`: o rótulo de uma região pode levar nome
 * de loja (`/contas`), de produto (o cabeçalho do SKU) ou uma data
 * (`/notificacoes`). Classes `sb-*` e posição não levam dado de ninguém.
 */

/** Uma classe do design system: `sb-` e só letra minúscula, dígito e hífen. */
const CLASSE_DO_SISTEMA = /^sb-[a-z0-9-]+$/;

/** O que pode chegar ao log: a forma descrita aqui e nada além. */
const DESCRICAO_VALIDA = /^[a-z0-9]+(\.sb-[a-z0-9-]+)*( < [a-z0-9]+(\.sb-[a-z0-9-]+)*(#[0-9]+)?)?$/;

const MAXIMO = 120;

/** `p.sb-meta-frase`: a tag e até duas classes do design system, na ordem do elemento. */
export function formaDoElemento(tag: string, classes: Iterable<string>): string {
  const doSistema = [...classes].filter((classe) => CLASSE_DO_SISTEMA.test(classe)).slice(0, 2);

  return [tag.toLowerCase(), ...doSistema].join(".");
}

/**
 * `p.sb-meta-frase < section.sb-panel#2`: o elemento e a seção em que mora, com a
 * posição dela (1 = a primeira seção do conteúdo). Sem seção, só o elemento.
 */
export function descreverElemento(elemento: string, secao: { forma: string; posicao: number } | null): string {
  const texto =
    secao === null ? elemento : `${elemento} < ${secao.forma}${secao.posicao > 0 ? `#${String(secao.posicao)}` : ""}`;

  return texto.slice(0, MAXIMO);
}

/** A descrição que a rota aceita: a forma acima, até 120 caracteres. Qualquer outra coisa não é gravada. */
export function descricaoValida(valor: unknown): valor is string {
  return typeof valor === "string" && valor.length > 0 && valor.length <= MAXIMO && DESCRICAO_VALIDA.test(valor);
}
