/** Timezone normativo de todas as métricas de venda (D-050). */
export const SALES_TIME_ZONE = "America/Sao_Paulo";

const businessDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SALES_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Converte um instante no dia civil usado pelas métricas.
 *
 * O cálculo SQL equivalente vive em `private.compute_daily_sales_metrics`.
 * Casos de fronteira iguais são exercitados nos testes puros e de integração
 * para impedir que a chave suja aponte para um dia diferente do rollup.
 */
export function toSalesMetricDate(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;

  if (Number.isNaN(date.getTime())) {
    throw new RangeError("instante inválido para data de métrica");
  }

  const parts = businessDateFormatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (year === undefined || month === undefined || day === undefined) {
    throw new RangeError("não foi possível calcular a data de métrica");
  }

  return `${year}-${month}-${day}`;
}

/**
 * Desloca uma data de negócio (`YYYY-MM-DD`) em N dias corridos.
 *
 * Aritmética de calendário, não de instante: constrói a data em UTC à
 * meia-noite só como representação interna, nunca como fuso — deslocar dia
 * civil em `America/Sao_Paulo` é o mesmo deslocar em qualquer fuso fixo,
 * porque não há troca de fuso no meio do cálculo (diferente de
 * `toSalesMetricDate`, que converte instante -> dia civil).
 */
export function shiftBusinessDate(date: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);

  if (match === null) {
    throw new RangeError("data de negócio inválida, esperado YYYY-MM-DD");
  }

  const [, year, month, day] = match as unknown as [string, string, string, string];
  const shifted = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));

  shifted.setUTCDate(shifted.getUTCDate() + days);

  return shifted.toISOString().slice(0, 10);
}
