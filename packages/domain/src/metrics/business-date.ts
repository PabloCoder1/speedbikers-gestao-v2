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
