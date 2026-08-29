import { businessDateRangeLength } from "@sb/domain";

/**
 * Alinhamento entre a série do período atual e a do período anterior no
 * gráfico de `/vendas` (D-137).
 *
 * **O problema que isto resolve.** `get_sales_daily_series` não fabrica zero:
 * um dia sem linha em `daily_account_metrics` fica AUSENTE do array. Logo o
 * índice de um ponto não é o dia dele dentro do período — é só a posição na
 * lista do que existe. Com uma série só isso era irrelevante; com duas, o
 * índice 5 de uma janela pode ser um dia relativo diferente do índice 5 da
 * outra, e o gráfico afirmaria "este dia contra o mesmo dia do período
 * anterior" sobre dois dias que não se correspondem.
 *
 * O offset em dias desde o início da janela é a única chave que significa a
 * mesma coisa nas duas — e as janelas têm o mesmo comprimento por construção
 * (`previousBusinessDateRange`), então `0..length-1` mapeia 1:1.
 *
 * Vive em `lib/` e não dentro do componente para ser testável sem React:
 * mesma razão de `sales-metric.ts` (D-136) e de `sku-curation.ts` (D-133).
 */

/** Posição de uma data dentro da janela que começa em `periodStart`, em dias (0 = primeiro dia). */
export function offsetInPeriod(date: string, periodStart: string): number {
  return businessDateRangeLength(periodStart, date) - 1;
}

/**
 * Indexa uma série pelo offset dentro da própria janela, para consulta cruzada
 * entre períodos. Devolve `Map`, não array denso: ausência continua sendo
 * ausência — quem consulta recebe `undefined` e pode dizer "sem dado", em vez
 * de receber 0 e afirmar "vendeu zero", que é outra coisa.
 */
export function indexByOffset<T extends { metric_date: string }>(
  series: readonly T[],
  periodStart: string,
): Map<number, T> {
  return new Map(series.map((point) => [offsetInPeriod(point.metric_date, periodStart), point]));
}
