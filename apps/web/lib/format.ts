const NUMBER = new Intl.NumberFormat("pt-BR");

const CURRENCY = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const DATE_TIME = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

/** O mesmo instante, só o DIA — mesmo fuso, pelo mesmo motivo (D-315). */
const DAY = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeZone: "America/Sao_Paulo",
});

/**
 * `YYYY-MM-DD` do DIA DE NEGÓCIO de um instante — a ponte que faltava entre um
 * `timestamptz` e o vocabulário de `formatBusinessDate` (D-393).
 *
 * **`en-CA` não é escolha de idioma: é o formato.** Essa localidade emite
 * exatamente `2026-09-14`, que é a forma que o resto do projeto já usa para dia
 * de negócio (`metric_date`, `p_date_from`). Escrever a mesma coisa com
 * `toISOString().slice(0, 10)` daria o dia **em UTC** — a armadilha que D-260
 * pagou, deslocando um histórico inteiro para outro dia da semana.
 *
 * Com isto, "é o mesmo dia?" vira comparação de duas strings do MESMO fuso, e
 * a regra de `lib/relative-time.ts` ("nunca decidir 'hoje' fora de um fuso")
 * continua valendo — ela só deixa de ser impossível de cumprir.
 */
const BUSINESS_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function businessDayOf(value: string | Date): string {
  const instante = value instanceof Date ? value : new Date(value);

  return BUSINESS_DAY.format(instante);
}

/** O dia da semana do dia de negócio ("segunda-feira"), para cabeçalho de grupo. */
const WEEKDAY = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  weekday: "long",
});

export function formatWeekday(value: string | Date): string {
  const instante = value instanceof Date ? value : new Date(value);

  return WEEKDAY.format(instante);
}

/**
 * Fuso fixado em America/Sao_Paulo.
 *
 * O servidor da Vercel roda em UTC e o banco guarda `timestamptz`. Sem fixar,
 * a mesma importação apareceria com hora diferente no servidor e no navegador,
 * e a conferência é justamente o momento em que alguém compara com a planilha.
 */
export function formatDateTime(value: string | null): string {
  if (value === null) return "—";

  return DATE_TIME.format(new Date(value));
}

/**
 * O DIA de um instante (`timestamptz`), sem a hora — para tabela larga, onde a
 * hora custa largura e não decide nada (D-315).
 *
 * **Não confundir com `formatBusinessDate`**, logo abaixo: aquela recebe
 * `YYYY-MM-DD` e NÃO pode passar por `new Date`. Esta recebe um instante e
 * precisa do fuso, exatamente como `formatDateTime`.
 */
export function formatDay(value: string | null): string {
  if (value === null) return "—";

  return DAY.format(new Date(value));
}

/**
 * Formata uma DATA DE NEGÓCIO (`YYYY-MM-DD`, sem componente de hora) — nunca
 * passar por `new Date(...)` aqui. Isso criaria meia-noite UTC e reconverteria
 * para `America/Sao_Paulo`, deslocando o dia civil que o valor já representa.
 * Manipulação de string, de propósito.
 */
export function formatBusinessDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (match === null) return "—";

  const [, year, month, day] = match as unknown as [string, string, string, string];

  return `${day}/${month}/${year}`;
}

export function formatCount(value: number | null): string {
  if (value === null) return "—";

  return NUMBER.format(value);
}

export function formatCurrency(value: number | null): string {
  if (value === null) return "—";

  return CURRENCY.format(value);
}

const PERCENT = new Intl.NumberFormat("pt-BR", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Recebe a FRAÇÃO (0.0728 → "7,3%"). `null` = indefinido (denominador zero), nunca 0% fingido. */
export function formatPercent(value: number | null): string {
  if (value === null) return "—";

  return PERCENT.format(value);
}

/**
 * Duração curta, em milissegundos (D-309).
 *
 * **Não é `formatCount`, e a diferença é um defeito real que a revisão pegou:**
 * `formatCount` agrupa milhar em pt-BR, então 3842 vira `3.842`, que se lê como
 * três vírgula oito. O pior tempo que a medição consegue produzir — quase o
 * limite de 4 s do timeout — seria justamente o que pareceria melhor.
 *
 * Abaixo de mil, milissegundo cru, sem agrupamento. De mil para cima, segundo
 * com uma casa: `3842` vira `3,8 s`, que ninguém confunde com rápido.
 */
export function formatLatency(ms: number | null): string {
  if (ms === null) return "—";

  if (ms < 1000) return `${String(Math.round(ms))} ms`;

  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}
