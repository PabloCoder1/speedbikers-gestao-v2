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
