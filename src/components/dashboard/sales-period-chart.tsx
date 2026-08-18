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
  period: {
    from: string;
    to: string;
    days: number;
    custom: boolean;
    abcClass: "A" | "B" | "C" | null;
  };
  basePath: string;
};

const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
});
const currencyExact = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
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

function formatExact(value: number, metric: DashboardMetric) {
  return metric === "revenue" ? currencyExact.format(value) : integer.format(value);
}

function formatDay(dateKey: string) {
  const [, month, day] = dateKey.split("-");
  return day + "/" + month;
}

const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function weekdayOf(dateKey: string) {
  // Meio-dia UTC mantém o dia civil correto em qualquer fuso.
  return WEEKDAYS[new Date(dateKey + "T12:00:00.000Z").getUTCDay()];
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
  const averagePercent = max > 0 ? (average / max) * 100 : 0;

  const periodParams = period.custom
    ? { de: period.from, ate: period.to }
    : { periodo: String(period.days) };

  const keep = {
    ...periodParams,
    classe: period.abcClass ?? undefined,
  };

  return (
    <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-100 p-5">
        <div>
          <h2 className="text-base font-bold tracking-tight text-gray-950">
            Vendas no período
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            {formatDay(period.from)} a {formatDay(period.to)}
            {period.custom ? " · personalizado" : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 rounded-xl bg-gray-100 p-1">
          {PRESETS.map((preset) => {
            const active = !period.custom && period.days === preset.days;
            return (
              <Link
                key={preset.days}
                href={dashboardHref(basePath, {
                  periodo: String(preset.days),
                  metrica: metric === "revenue" ? undefined : metric,
                  classe: period.abcClass ?? undefined,
                })}
                aria-current={active ? "page" : undefined}
                className={
                  "rounded-lg px-3 py-1.5 text-xs font-semibold transition " +
                  (active
                    ? "bg-white text-gray-950 shadow-sm"
                    : "text-gray-500 hover:text-gray-950")
                }
              >
                {preset.label}
              </Link>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 border-b border-gray-100 p-5 sm:grid-cols-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
            Total no período
          </p>
          <p className="mt-1 text-2xl font-bold tracking-tight text-gray-950">
            {formatExact(total, metric)}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
            Média por dia
          </p>
          <p className="mt-1 text-2xl font-bold tracking-tight text-gray-950">
            {formatExact(
              metric === "revenue" ? average : Math.round(average),
              metric,
            )}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
            Melhor dia
          </p>
          <p className="mt-1 text-2xl font-bold tracking-tight text-gray-950">
            {best && best.value > 0 ? formatExact(best.value, metric) : "—"}
          </p>
          {best && best.value > 0 ? (
            <p className="text-[11px] text-gray-500">
              {formatDay(best.point.date)} · {weekdayOf(best.point.date)}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
        <div className="flex flex-wrap items-center gap-1">
          {METRICS.map((option) => (
            <Link
              key={option.value}
              href={dashboardHref(basePath, {
                ...keep,
                metrica: option.value === "revenue" ? undefined : option.value,
              })}
              aria-current={metric === option.value ? "page" : undefined}
              className={
                "rounded-lg px-2.5 py-1.5 text-xs font-medium transition " +
                (metric === option.value
                  ? "bg-gray-950 text-white"
                  : "text-gray-500 hover:bg-gray-100")
              }
            >
              {option.label}
            </Link>
          ))}
        </div>

        <form method="get" action={basePath} className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            name="de"
            defaultValue={period.from}
            aria-label="Data inicial"
            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-gray-950"
          />
          <span className="text-xs text-gray-400">até</span>
          <input
            type="date"
            name="ate"
            defaultValue={period.to}
            aria-label="Data final"
            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-gray-950"
          />
          {metric !== "revenue" ? (
            <input type="hidden" name="metrica" value={metric} />
          ) : null}
          {period.abcClass ? (
            <input type="hidden" name="classe" value={period.abcClass} />
          ) : null}
          <button
            type="submit"
            className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-700 transition hover:bg-gray-200"
          >
            Aplicar
          </button>
        </form>
      </div>

      {max <= 0 ? (
        <p className="m-5 rounded-xl bg-gray-50 px-4 py-10 text-center text-sm text-gray-500">
          Nenhuma venda registrada neste período.
        </p>
      ) : (
        <div className="p-5">
          <div className="relative">
            {/*
              A linha da média dá referência visual imediata: dá para ver
              quais dias ficaram acima sem comparar números.
            */}
            <div
              className="pointer-events-none absolute inset-x-0 border-t border-dashed border-gray-300"
              style={{ bottom: String(averagePercent) + "%" }}
            >
              <span className="absolute -top-4 right-0 rounded bg-white px-1 text-[10px] font-medium text-gray-400">
                média {formatValue(average, metric)}
              </span>
            </div>

            <div
              className="flex h-56 items-stretch gap-[3px]"
              role="img"
              aria-label={
                "Vendas por dia de " + period.from + " a " + period.to
              }
            >
              {series.map((point) => {
                const value = valueOf(point, metric);
                const heightPercent = max > 0 ? (value / max) * 100 : 0;
                const isBest = best?.point.date === point.date && value > 0;
                return (
                  <div
                    key={point.date}
                    className="group relative flex min-w-[5px] flex-1 flex-col justify-end"
                  >
                    <div
                      className={
                        "w-full rounded-t-md transition-colors " +
                        (isBest
                          ? "bg-gray-950"
                          : "bg-gray-900/25 group-hover:bg-gray-900/60")
                      }
                      style={{
                        height:
                          String(Math.max(heightPercent, value > 0 ? 1.5 : 0)) +
                          "%",
                      }}
                    />

                    <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-lg bg-gray-950 px-2 py-1 text-[11px] font-medium text-white shadow-lg group-hover:block">
                      {formatDay(point.date)} · {weekdayOf(point.date)}
                      <span className="block font-bold">
                        {formatExact(value, metric)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-2 flex gap-[3px]">
            {series.map((point, index) => (
              <div key={point.date} className="min-w-[5px] flex-1 text-center">
                {index % labelStep === 0 ? (
                  <span className="text-[9px] tabular-nums text-gray-400">
                    {formatDay(point.date)}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
