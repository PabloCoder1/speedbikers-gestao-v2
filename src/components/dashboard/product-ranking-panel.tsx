import Link from "next/link";

import {
  dashboardHref,
  type DashboardMetric,
} from "@/components/dashboard/sales-period-chart";

type AbcClassName = "A" | "B" | "C";

type AbcClass = {
  className: AbcClassName;
  products: number;
  metricValue: number;
  unitsSold: number;
  grossRevenue: number;
  metricShare: number;
};

type RankedProduct = {
  position: number;
  productId: string;
  sku: string;
  name: string | null;
  abcClass: AbcClassName;
  unitsSold: number;
  ordersCount: number;
  grossRevenue: number;
  metricValue: number;
  metricShare: number;
  cumulativeShare: number;
  averageUnitPrice: number;
};

type ProductRankingPanelProps = {
  ranking: {
    metricTotal: number;
    rankedProducts: number;
    listedProducts: number;
    abc: AbcClass[];
    top: RankedProduct[];
  };
  metric: DashboardMetric;
  period: {
    from: string;
    to: string;
    days: number;
    custom: boolean;
    abcClass: AbcClassName | null;
  };
  basePath: string;
};

const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const integer = new Intl.NumberFormat("pt-BR");
const percent = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const METRIC_LABEL: Record<DashboardMetric, string> = {
  revenue: "faturamento",
  units: "unidades",
  orders: "pedidos",
};

const CLASS_STYLE: Record<
  AbcClassName,
  { bar: string; chip: string; activeChip: string; hint: string }
> = {
  A: {
    bar: "bg-emerald-500",
    chip: "border-emerald-200 bg-emerald-50 text-emerald-800",
    activeChip: "border-emerald-600 bg-emerald-600 text-white",
    hint: "Concentram a maior parte do resultado. Nunca podem faltar.",
  },
  B: {
    bar: "bg-amber-500",
    chip: "border-amber-200 bg-amber-50 text-amber-800",
    activeChip: "border-amber-600 bg-amber-600 text-white",
    hint: "Peso intermediário. Reposição planejada, sem urgência.",
  },
  C: {
    bar: "bg-gray-400",
    chip: "border-gray-200 bg-gray-50 text-gray-700",
    activeChip: "border-gray-700 bg-gray-700 text-white",
    hint: "Cauda longa. Muitos itens, pouco resultado.",
  },
};

function formatMetric(value: number, metric: DashboardMetric) {
  return metric === "revenue" ? currency.format(value) : integer.format(value);
}

export function ProductRankingPanel({
  ranking,
  metric,
  period,
  basePath,
}: ProductRankingPanelProps) {
  const periodParams = period.custom
    ? { de: period.from, ate: period.to }
    : { periodo: String(period.days) };

  const metricParam = metric === "revenue" ? undefined : metric;
  const byClass = new Map(ranking.abc.map((row) => [row.className, row]));
  const classes: AbcClassName[] = ["A", "B", "C"];
  const selected = period.abcClass;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-100 p-5">
        <div>
          <h2 className="text-base font-bold tracking-tight text-gray-950">
            Curva ABC
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-gray-500">
            Por {METRIC_LABEL[metric]}. A até 80% do acumulado, B até 95%, C o
            restante. {integer.format(ranking.rankedProducts)} produto(s) com venda no
            período — os que não venderam ficam fora da curva.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {(["revenue", "units", "orders"] as DashboardMetric[]).map((option) => (
            <Link
              key={option}
              href={dashboardHref(basePath, {
                ...periodParams,
                metrica: option === "revenue" ? undefined : option,
                classe: selected ?? undefined,
              })}
              aria-current={metric === option ? "page" : undefined}
              className={
                "rounded-lg px-2.5 py-1.5 text-xs font-medium transition " +
                (metric === option
                  ? "bg-gray-950 text-white"
                  : "text-gray-500 hover:bg-gray-100")
              }
            >
              {METRIC_LABEL[option]}
            </Link>
          ))}
        </div>
      </div>

      {ranking.rankedProducts === 0 ? (
        <p className="m-5 rounded-xl bg-gray-50 px-4 py-10 text-center text-sm text-gray-500">
          Nenhum produto vendeu no período.
        </p>
      ) : (
        <>
          <div className="grid gap-3 border-b border-gray-100 p-5 md:grid-cols-3">
            {classes.map((className) => {
              const row = byClass.get(className);
              const style = CLASS_STYLE[className];
              const share = row?.metricShare ?? 0;
              const active = selected === className;

              return (
                <Link
                  key={className}
                  href={dashboardHref(basePath, {
                    ...periodParams,
                    metrica: metricParam,
                    classe: active ? undefined : className,
                  })}
                  aria-current={active ? "page" : undefined}
                  className={
                    "rounded-xl border p-4 transition " +
                    (active
                      ? "border-gray-950 bg-gray-950 text-white"
                      : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50")
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={
                        "rounded-full border px-2 py-0.5 text-xs font-bold " +
                        (active ? "border-white/30 bg-white/15 text-white" : style.chip)
                      }
                    >
                      Classe {className}
                    </span>
                    <span
                      className={
                        "text-lg font-bold tracking-tight " +
                        (active ? "text-white" : "text-gray-950")
                      }
                    >
                      {percent.format(share)}%
                    </span>
                  </div>

                  <p
                    className={
                      "mt-3 text-2xl font-bold tracking-tight " +
                      (active ? "text-white" : "text-gray-950")
                    }
                  >
                    {integer.format(row?.products ?? 0)}
                  </p>
                  <p
                    className={
                      "text-[11px] " + (active ? "text-white/70" : "text-gray-500")
                    }
                  >
                    produtos · {formatMetric(row?.metricValue ?? 0, metric)}
                  </p>

                  <div
                    className={
                      "mt-3 h-1.5 w-full overflow-hidden rounded-full " +
                      (active ? "bg-white/20" : "bg-gray-100")
                    }
                  >
                    <div
                      className={
                        "h-full rounded-full " + (active ? "bg-white" : style.bar)
                      }
                      style={{ width: String(Math.min(share, 100)) + "%" }}
                    />
                  </div>

                  <p
                    className={
                      "mt-2 text-[11px] leading-4 " +
                      (active ? "text-white/70" : "text-gray-500")
                    }
                  >
                    {active ? "Mostrando estes produtos abaixo" : style.hint}
                  </p>
                </Link>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
            <p className="text-xs text-gray-500">
              {selected
                ? "Produtos da classe " +
                  selected +
                  " · " +
                  integer.format(ranking.listedProducts) +
                  " no total"
                : "Todos os produtos, ordenados por " + METRIC_LABEL[metric]}
              {ranking.top.length < ranking.listedProducts
                ? " · exibindo os " + integer.format(ranking.top.length) + " primeiros"
                : ""}
            </p>

            {selected ? (
              <Link
                href={dashboardHref(basePath, {
                  ...periodParams,
                  metrica: metricParam,
                })}
                className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-semibold text-gray-700 transition hover:bg-gray-50"
              >
                Ver todas as classes
              </Link>
            ) : null}
          </div>

          <div className="overflow-x-auto p-5 pt-3">
            <table className="w-full min-w-[720px] text-left">
              <thead className="border-b border-gray-200 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="py-2 pr-2">#</th>
                  <th className="py-2 pr-2">Produto</th>
                  <th className="py-2 pr-2">ABC</th>
                  <th className="py-2 pr-2 text-right">Faturamento</th>
                  <th className="py-2 pr-2 text-right">Unidades</th>
                  <th className="py-2 pr-2 text-right">Pedidos</th>
                  <th className="py-2 pr-2 text-right">Participação</th>
                  <th className="py-2 text-right">Acumulado</th>
                </tr>
              </thead>
              <tbody>
                {ranking.top.map((product) => (
                  <tr
                    key={product.productId}
                    className="border-b border-gray-100 last:border-0 hover:bg-gray-50"
                  >
                    <td className="py-2.5 pr-2 text-xs tabular-nums text-gray-400">
                      {product.position}
                    </td>
                    <td className="py-2.5 pr-2">
                      <Link
                        href={"/produto/" + product.productId}
                        className="text-sm font-semibold text-gray-950 underline-offset-2 hover:underline"
                      >
                        {product.sku}
                      </Link>
                      <p className="max-w-sm truncate text-[11px] text-gray-500">
                        {product.name ?? "Sem nome cadastrado"}
                      </p>
                    </td>
                    <td className="py-2.5 pr-2">
                      <span
                        className={
                          "inline-flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-bold " +
                          CLASS_STYLE[product.abcClass].chip
                        }
                      >
                        {product.abcClass}
                      </span>
                    </td>
                    <td
                      className={
                        "py-2.5 pr-2 text-right text-sm tabular-nums " +
                        (metric === "revenue"
                          ? "font-bold text-gray-950"
                          : "text-gray-600")
                      }
                    >
                      {currency.format(product.grossRevenue)}
                    </td>
                    <td
                      className={
                        "py-2.5 pr-2 text-right text-sm tabular-nums " +
                        (metric === "units"
                          ? "font-bold text-gray-950"
                          : "text-gray-600")
                      }
                    >
                      {integer.format(product.unitsSold)}
                    </td>
                    <td
                      className={
                        "py-2.5 pr-2 text-right text-sm tabular-nums " +
                        (metric === "orders"
                          ? "font-bold text-gray-950"
                          : "text-gray-600")
                      }
                    >
                      {integer.format(product.ordersCount)}
                    </td>
                    <td className="py-2.5 pr-2 text-right text-xs tabular-nums text-gray-600">
                      {percent.format(product.metricShare)}%
                    </td>
                    <td className="py-2.5 text-right text-xs tabular-nums text-gray-400">
                      {percent.format(product.cumulativeShare)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
