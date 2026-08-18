import { shiftSaoPauloDateKey } from "@/lib/date/sao-paulo";

export type ResolvedDashboardPeriod = {
  from: string;
  to: string;
  days: number;
  custom: boolean;
  /*
   * Início da leitura em daily_account_metrics: cobre o período do
   * gráfico E os 30 dias fixos dos cards, com uma consulta só.
   */
  rangeStart: string;
};

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isDashboardDateKey(value: unknown): value is string {
  return typeof value === "string" && DATE_KEY.test(value);
}

/*
 * Resolve o período do gráfico a partir dos parâmetros da URL.
 *
 * Um intervalo personalizado válido tem prioridade sobre o preset. Os
 * presets contam dias completos anteriores e incluem hoje ainda
 * acumulando, na mesma convenção dos cards — "7 dias" é hoje mais os
 * seis anteriores.
 */
export function resolveDashboardPeriod({
  today,
  thirtyDaysAgo,
  periodDays,
  dateFrom,
  dateTo,
}: {
  today: string;
  thirtyDaysAgo: string;
  periodDays: number;
  dateFrom: string | null;
  dateTo: string | null;
}): ResolvedDashboardPeriod {
  const custom =
    isDashboardDateKey(dateFrom) &&
    isDashboardDateKey(dateTo) &&
    dateFrom <= dateTo &&
    // Um intervalo que começa depois de hoje não tem dado nenhum.
    dateFrom <= today;

  const safeDays = Math.min(Math.max(Math.trunc(Number(periodDays) || 30), 1), 365);

  const from = custom ? dateFrom! : shiftSaoPauloDateKey(today, -(safeDays - 1));

  // Nunca projetamos além de hoje: não existe métrica de dia futuro.
  const to = custom ? (dateTo! < today ? dateTo! : today) : today;

  const days = custom ? countDays(from, to) : safeDays;

  return {
    from,
    to,
    days,
    custom,
    rangeStart: from < thirtyDaysAgo ? from : thirtyDaysAgo,
  };
}

function countDays(from: string, to: string) {
  let count = 0;
  let cursor = from;
  while (cursor <= to && count < 400) {
    count += 1;
    cursor = shiftSaoPauloDateKey(cursor, 1);
  }
  return count;
}
