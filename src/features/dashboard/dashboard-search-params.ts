import type { DashboardRankingMetric } from "@/features/dashboard/get-dashboard-overview";

const ALLOWED_METRICS = new Set<DashboardRankingMetric>([
  "revenue",
  "units",
  "orders",
]);

const ALLOWED_PERIODS = new Set([7, 30, 90]);

const ALLOWED_CLASSES = new Set(["A", "B", "C"]);

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function dateKeyOrNull(value: string | undefined) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/*
 * Traduz a query string do dashboard em parâmetros validados.
 * Valor desconhecido cai no padrão em vez de propagar para o SQL.
 */
export function readDashboardSearchParams(
  raw: Record<string, string | string[] | undefined>,
) {
  const rawPeriod = Number(firstValue(raw.periodo));
  const rawMetric = firstValue(raw.metrica) as DashboardRankingMetric | undefined;
  const rawClass = (firstValue(raw.classe) ?? "").toUpperCase();

  return {
    periodDays: ALLOWED_PERIODS.has(rawPeriod) ? rawPeriod : 30,
    dateFrom: dateKeyOrNull(firstValue(raw.de)),
    dateTo: dateKeyOrNull(firstValue(raw.ate)),
    rankingMetric:
      rawMetric && ALLOWED_METRICS.has(rawMetric) ? rawMetric : "revenue",
    abcClass: ALLOWED_CLASSES.has(rawClass)
      ? (rawClass as "A" | "B" | "C")
      : null,
  } as const;
}
