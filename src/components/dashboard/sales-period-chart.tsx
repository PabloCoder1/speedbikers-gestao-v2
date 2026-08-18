import Link from "next/link";

type SeriesPoint = {
  date: string;
  grossRevenue: number;
  unitsSold: number;
  totalOrders: number;
};

export type DashboardMetric = "revenue" | "units" | "orders";

type SalesPeriodChartProps = {
  series: SeriesPoint[];
  metric: DashboardMetric;
  period: { from: string; to: string; days: number; custom: boolean };
  basePath: string;
};

const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
});
const integer = new Intl.NumberFormat("pt-BR");

const PRESETS = [
  { days: 7, label: "7 dias" },
  { days: 30, label: "30 dias" },
  { days: 90, label: "90 dias" },
];

const METRICS: { value: DashboardMetric; label: string }[] = [
  { value: "revenue", label: "Faturamento" },
  { value: "units", label: "Unidades" },
  { value: "orders", label: "Pedidos" },
];

function valueOf(point: SeriesPoint, metric: DashboardMetric) {
  if (metric === "units") return point.unitsSold;
  if (metric === "orders") return point.totalOrders;
  return point.grossRevenue;
}

function formatValue(value: number, metric: DashboardMetric) {
  return metric === "revenue" ? currency.format(value) : integer.format(value);
}

function formatDay(dateKey: string) {
  const [, month, day] = dateKey.split("-");
  return day + "/" + month;
}

export function dashboardHref(
  basePath: string,
  params: Record<string, string | undefined>,
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const suffix = search.toString();
  return suffix ? basePath + "?" + suffix : basePath;
}

export function SalesPeriodChart({
  series,
  metric,
  period,
  basePath,
}: SalesPeriodChartProps) {
  const values = series.map((point) => valueOf(point, metric));
  const max = Math.max(...values, 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const average = series.length > 0 ? total / series.length : 0;
  const best = series.reduce<{ point: SeriesPoint; value: number } | null>(
    (top, point) => {
      const value = valueOf(point, metric);
      return !top || value > top.value ? { point, value } : top;
    },
    null,
  );

  /*
   * Com 90 dias, rotular todas as barras vira ruído ilegível.
   * O passo mantém cerca de 12 rótulos em qualquer período.
   */
  const labelStep = Math.max(1, Math.ceil(series.length / 12));

  const periodParams = period.custom
    ? { de: period.from, ate: period.to }
    : { periodo: String(period.days) };

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-bold tracking-tight text-gray-950">
            Vendas no período
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            {period.from} a {period.to}
            {period.custom ? " (personalizado)" : ""} · {formatValue(total, metric)} no
            total · média de {formatValue(Math.round(average), metric)} por dia
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {PRESETS.map((preset) => {
            const active = !period.custom && period.days === preset.days;
            return (
              <Link
                key={preset.days}
                href={dashboardHref(basePath, {
                  periodo: String(preset.days),
                  metrica: metric === "revenue" ? undefined : metric,
                })}
                aria-current={active ? "page" : undefined}
                className={
                  "rounded-xl px-3 py-2 text-xs font-semibold transition " +
                  (active
                    ? "bg-gray-950 text-white"
                    : "border border-gray-200 text-gray-700 hover:bg-gray-50")
                }
              >
                {preset.label}
              </Link>
            );
          })}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          Medir por
        </span>
        {METRICS.map((option) => (
          <Link
            key={option.value}
            href={dashboardHref(basePath, {
              ...periodParams,
              metrica: option.value === "revenue" ? undefined : option.value,
            })}
            aria-current={metric === option.value ? "page" : undefined}
            className={
              "rounded-lg px-2.5 py-1.5 text-xs font-medium transition " +
              (metric === option.value
                ? "bg-gray-100 text-gray-950"
                : "text-gray-500 hover:bg-gray-50")
            }
          >
            {option.label}
          </Link>
        ))}
      </div>

      <form method="get" action={basePath} className="mt-3 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="periodo-de" className="text-[11px] font-medium text-gray-500">
            De
          </label>
          <input
            id="periodo-de"
            type="date"
            name="de"
            defaultValue={period.from}
            className="mt-1 block rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-gray-950"
          />
        </div>
        <div>
          <label htmlFor="periodo-ate" className="text-[11px] font-medium text-gray-500">
            Até
          </label>
          <input
            id="periodo-ate"
            type="date"
            name="ate"
            defaultValue={period.to}
            className="mt-1 block rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-gray-950"
          />
        </div>
        {metric !== "revenue" ? (
          <input type="hidden" name="metrica" value={metric} />
        ) : null}
        <button
          type="submit"
          className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 transition hover:bg-gray-50"
        >
          Aplicar
        </button>
      </form>

      {max <= 0 ? (
        <p className="mt-6 rounded-xl bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
          Nenhuma venda registrada neste período.
        </p>
      ) : (
        <div className="mt-5 overflow-x-auto">
          <div
            className="flex min-w-full items-end gap-1"
            style={{ height: "180px" }}
            role="img"
            aria-label={"Vendas por dia de " + period.from + " a " + period.to}
          >
            {series.map((point) => {
              const value = valueOf(point, metric);
              const heightPercent = max > 0 ? (value / max) * 100 : 0;
              const isBest = best?.point.date === point.date && value > 0;
              return (
                <div
                  key={point.date}
                  className="flex min-w-[6px] flex-1 flex-col justify-end"
                  title={formatDay(point.date) + ": " + formatValue(value, metric)}
                >
                  <div
                    className={
                      "w-full rounded-t " + (isBest ? "bg-gray-950" : "bg-gray-300")
                    }
                    style={{
                      height:
                        String(Math.max(heightPercent, value > 0 ? 2 : 0)) + "%",
                    }}
                  />
                </div>
              );
            })}
          </div>

          <div className="mt-2 flex min-w-full gap-1">
            {series.map((point, index) => (
              <div key={point.date} className="min-w-[6px] flex-1 text-center">
                {index % labelStep === 0 ? (
                  <span className="text-[9px] text-gray-400">
                    {formatDay(point.date)}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}

      {best && best.value > 0 ? (
        <p className="mt-3 text-xs text-gray-500">
          Melhor dia: {formatDay(best.point.date)} com {formatValue(best.value, metric)}.
        </p>
      ) : null}
    </section>
  );
}
