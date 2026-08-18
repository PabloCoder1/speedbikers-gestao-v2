import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  dashboardHref,
  type DashboardMetric,
} from "@/components/dashboard/sales-period-chart";

type AbcClass = {
  className: "A" | "B" | "C";
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
  abcClass: "A" | "B" | "C";
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
    abc: AbcClass[];
    top: RankedProduct[];
  };
  metric: DashboardMetric;
  period: { from: string; to: string; days: number; custom: boolean };
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
  AbcClass["className"],
  { badge: "success" | "warning" | "neutral"; bar: string; hint: string }
> = {
  A: {
    badge: "success",
    bar: "bg-emerald-500",
    hint: "Concentram a maior parte do resultado. Nunca podem faltar.",
  },
  B: {
    badge: "warning",
    bar: "bg-amber-500",
    hint: "Peso intermediário. Reposição planejada, sem urgência.",
  },
  C: {
    badge: "neutral",
    bar: "bg-gray-400",
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

  const byClass = new Map(ranking.abc.map((row) => [row.className, row]));
  const classes: AbcClass["className"][] = ["A", "B", "C"];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-bold tracking-tight text-gray-950">Curva ABC</h2>
        <p className="mt-1 text-xs leading-5 text-gray-500">
          Classificação por {METRIC_LABEL[metric]} no período. A vai até 80% do
          acumulado, B até 95%, C o restante. {integer.format(ranking.rankedProducts)}{" "}
          produto(s) com venda.
        </p>

        {ranking.rankedProducts === 0 ? (
          <p className="mt-5 rounded-xl bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
            Nenhum produto vendeu no período.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            {classes.map((className) => {
              const row = byClass.get(className);
              const style = CLASS_STYLE[className];
              const share = row?.metricShare ?? 0;
              return (
                <div key={className}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant={style.badge}>Classe {className}</Badge>
                      <span className="text-sm font-semibold text-gray-950">
                        {integer.format(row?.products ?? 0)} produto(s)
                      </span>
                    </div>
                    <span className="text-sm font-bold tracking-tight text-gray-950">
                      {percent.format(share)}%
                    </span>
                  </div>

                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
                    <div
                      className={"h-full rounded-full " + style.bar}
                      style={{ width: String(Math.min(share, 100)) + "%" }}
                    />
                  </div>

                  <p className="mt-1.5 text-[11px] leading-4 text-gray-500">
                    {formatMetric(row?.metricValue ?? 0, metric)} · {style.hint}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold tracking-tight text-gray-950">
              Top produtos
            </h2>
            <p className="mt-1 text-xs text-gray-500">
              Ordenado por {METRIC_LABEL[metric]} · {period.from} a {period.to}
            </p>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {(["revenue", "units", "orders"] as DashboardMetric[]).map((option) => (
              <Link
                key={option}
                href={dashboardHref(basePath, {
                  ...periodParams,
                  metrica: option === "revenue" ? undefined : option,
                })}
                aria-current={metric === option ? "page" : undefined}
                className={
                  "rounded-lg px-2.5 py-1.5 text-xs font-medium transition " +
                  (metric === option
                    ? "bg-gray-950 text-white"
                    : "border border-gray-200 text-gray-600 hover:bg-gray-50")
                }
              >
                {METRIC_LABEL[option]}
              </Link>
            ))}
          </div>
        </div>

        {ranking.top.length === 0 ? (
          <p className="mt-5 rounded-xl bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
            Nenhum produto vendeu no período.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left">
              <thead className="border-b border-gray-200 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="py-2 pr-2">#</th>
                  <th className="py-2 pr-2">Produto</th>
                  <th className="py-2 pr-2">ABC</th>
                  <th className="py-2 pr-2 text-right">Faturamento</th>
                  <th className="py-2 pr-2 text-right">Unidades</th>
                  <th className="py-2 pr-2 text-right">Pedidos</th>
                  <th className="py-2 text-right">Acumulado</th>
                </tr>
              </thead>
              <tbody>
                {ranking.top.map((product) => (
                  <tr key={product.productId} className="border-b border-gray-100">
                    <td className="py-2.5 pr-2 text-xs text-gray-400">
                      {product.position}
                    </td>
                    <td className="py-2.5 pr-2">
                      <Link
                        href={"/produto/" + product.productId}
                        className="text-sm font-semibold text-gray-950 underline-offset-2 hover:underline"
                      >
                        {product.sku}
                      </Link>
                      <p className="max-w-xs truncate text-[11px] text-gray-500">
                        {product.name ?? "Sem nome cadastrado"}
                      </p>
                    </td>
                    <td className="py-2.5 pr-2">
                      <Badge variant={CLASS_STYLE[product.abcClass].badge}>
                        {product.abcClass}
                      </Badge>
                    </td>
                    <td
                      className={
                        "py-2.5 pr-2 text-right text-sm " +
                        (metric === "revenue"
                          ? "font-bold text-gray-950"
                          : "text-gray-600")
                      }
                    >
                      {currency.format(product.grossRevenue)}
                    </td>
                    <td
                      className={
                        "py-2.5 pr-2 text-right text-sm " +
                        (metric === "units"
                          ? "font-bold text-gray-950"
                          : "text-gray-600")
                      }
                    >
                      {integer.format(product.unitsSold)}
                    </td>
                    <td
                      className={
                        "py-2.5 pr-2 text-right text-sm " +
                        (metric === "orders"
                          ? "font-bold text-gray-950"
                          : "text-gray-600")
                      }
                    >
                      {integer.format(product.ordersCount)}
                    </td>
                    <td className="py-2.5 text-right text-xs text-gray-500">
                      {percent.format(product.cumulativeShare)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
