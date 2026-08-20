const NUMBER = new Intl.NumberFormat("pt-BR");

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

export function formatCount(value: number | null): string {
  if (value === null) return "—";

  return NUMBER.format(value);
}
