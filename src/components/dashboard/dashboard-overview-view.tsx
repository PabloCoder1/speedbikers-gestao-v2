import Link from "next/link";

import { DailyRevenueBars } from "@/components/dashboard/daily-revenue-bars";
import { ProductRankingPanel } from "@/components/dashboard/product-ranking-panel";
import { SalesPeriodChart } from "@/components/dashboard/sales-period-chart";
import { DashboardMetricCard } from "@/components/dashboard/dashboard-metric-card";
import { TopProductsTable } from "@/components/dashboard/top-products-table";
import type { getDashboardOverview } from "@/features/dashboard/get-dashboard-overview";


type DashboardOverview =
  NonNullable<
    Awaited<
      ReturnType<
        typeof getDashboardOverview
      >
    >
  >;

type DashboardOverviewViewProps = {
  dashboard:
    DashboardOverview;
};


const currency =
  new Intl.NumberFormat(
    "pt-BR",
    {
      style:
        "currency",

      currency:
        "BRL",
    },
  );


const integer =
  new Intl.NumberFormat(
    "pt-BR",
  );


const dayMonth =
  new Intl.DateTimeFormat(
    "pt-BR",
    {
      day:
        "2-digit",

      month:
        "2-digit",

      timeZone:
        "UTC",
    },
  );


/*
 * Metric dates are plain calendar keys, so they are read at
 * noon UTC to stay on the intended day in any timezone.
 */
function formatRange(
  from: string,
  to: string,
) {
  return `${dayMonth.format(
    new Date(
      `${from}T12:00:00.000Z`,
    ),
  )} a ${dayMonth.format(
    new Date(
      `${to}T12:00:00.000Z`,
    ),
  )}`;
}


function percentageChange(
  current: number,
  previous: number,
) {
  if (
    previous === 0
  ) {
    return current === 0
      ? 0
      : null;
  }


  return (
    (
      current -
      previous
    ) /
    previous
  ) * 100;
}


function cancellationRate(
  cancelledOrders: number,
  totalOrders: number,
) {
  if (
    totalOrders === 0
  ) {
    return 0;
  }


  return (
    cancelledOrders /
    totalOrders
  ) * 100;
}


export function DashboardOverviewView({
  dashboard,
}: DashboardOverviewViewProps) {
  const {
    selectedAccount,
    availableAccounts,
    today,
    todayMetric,
    yesterdayMetric,
    soldSkuCount,
    last7Days,
    last7DaysStart,
    last30Days,
    last30DaysStart,
    last14Days,
    topProducts,
  } = dashboard;


  /*
   * Os filtros de período e métrica viajam na URL, então precisam
   * apontar para a rota atual — geral ou da conta selecionada.
   */
  const basePath = selectedAccount
    ? `/conta/${selectedAccount.code}`
    : "/";


  const revenueVariation =
    percentageChange(
      todayMetric.grossRevenue,
      yesterdayMetric.grossRevenue,
    );


  const ordersVariation =
    percentageChange(
      todayMetric.totalOrders,
      yesterdayMetric.totalOrders,
    );


  const unitsVariation =
    percentageChange(
      todayMetric.unitsSold,
      yesterdayMetric.unitsSold,
    );


  const cancellation =
    cancellationRate(
      todayMetric.cancelledOrders,
      todayMetric.totalOrders,
    );


  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <div className="mb-6">
        <p className="text-sm font-medium text-gray-500">
          {selectedAccount
            ? "Conta Mercado Livre"
            : "Speed Bikers"}
        </p>

        <div className="mt-1 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-gray-950">
              {selectedAccount
                ? selectedAccount
                    .displayName
                : "Visão Geral"}
            </h1>

            <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
              {selectedAccount
                ? `Desempenho comercial individual da conta ${selectedAccount.displayName}.`
                : "Desempenho comercial consolidado das contas Mercado Livre disponíveis para o seu acesso."}
            </p>

            {selectedAccount ? (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
                {selectedAccount.nickname ? (
                  <span>
                    {selectedAccount.nickname}
                  </span>
                ) : null}

                {selectedAccount.sellerId ? (
                  <span>
                    Seller{" "}
                    {
                      selectedAccount
                        .sellerId
                    }
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>


          <div className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs text-gray-500">
            Atualização baseada nas sincronizações automáticas
          </div>
        </div>
      </div>


      <nav
        aria-label="Escopo do dashboard"
        className="mb-8 flex flex-wrap gap-2"
      >
        <Link
          href="/"
          className={`rounded-xl border px-4 py-2 text-sm font-medium transition ${
            !selectedAccount
              ? "border-gray-950 bg-gray-950 text-white"
              : "border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50"
          }`}
        >
          Visão Geral
        </Link>

        {availableAccounts.map(
          (account) => {
            const isActive =
              selectedAccount
                ?.code ===
              account.code;

            return (
              <Link
                key={
                  account.id
                }
                href={`/conta/${account.code}`}
                className={`rounded-xl border px-4 py-2 text-sm font-medium transition ${
                  isActive
                    ? "border-gray-950 bg-gray-950 text-white"
                    : "border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50"
                }`}
              >
                {
                  account.displayName
                }
              </Link>
            );
          },
        )}
      </nav>


      <section>
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-gray-950">
            Hoje
          </h2>
        </div>


        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <DashboardMetricCard
            label="Vendas"
            value={
              integer.format(
                todayMetric.totalOrders,
              )
            }
            variation={
              ordersVariation
            }
            helper="Quantidade de vendas · comparação com ontem"
          />


          <DashboardMetricCard
            label="Faturamento"
            value={
              currency.format(
                todayMetric.grossRevenue,
              )
            }
            variation={
              revenueVariation
            }
            helper="Vendas brutas (mesma regra do Mercado Livre)"
          />


          <DashboardMetricCard
            label="Unidades vendidas"
            value={
              integer.format(
                todayMetric.unitsSold,
              )
            }
            variation={
              unitsVariation
            }
            helper="Soma das quantidades vendidas"
          />


          <DashboardMetricCard
            label="SKUs que venderam"
            value={
              integer.format(
                soldSkuCount,
              )
            }
            helper="Produtos únicos com venda hoje"
          />


          <DashboardMetricCard
            label="Cancelamentos"
            value={
              `${cancellation.toFixed(
                1,
              )}%`
            }
            helper={`${integer.format(
              todayMetric.cancelledOrders,
            )} pedidos cancelados hoje`}
          />
        </div>
      </section>


      <section className="mt-8">
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-gray-950">
            Períodos
          </h2>
        </div>


        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <DashboardMetricCard
            label="Faturamento 7 dias"
            value={
              currency.format(
                last7Days.grossRevenue,
              )
            }
            helper={`${integer.format(
              last7Days.unitsSold,
            )} unidades · ${formatRange(
              last7DaysStart,
              today,
            )}`}
          />


          <DashboardMetricCard
            label="Faturamento 30 dias"
            value={
              currency.format(
                last30Days.grossRevenue,
              )
            }
            helper={`${integer.format(
              last30Days.totalOrders,
            )} vendas · ${formatRange(
              last30DaysStart,
              today,
            )}`}
          />


          <DashboardMetricCard
            label="Taxas de venda 30 dias"
            value={
              currency.format(
                last30Days.saleFees,
              )
            }
            helper="Taxas registradas nos itens dos pedidos"
          />


          <DashboardMetricCard
            label="Receita após taxa"
            value={
              currency.format(
                last30Days.netAfterSaleFee,
              )
            }
            helper="Ainda não representa lucro líquido"
          />
        </div>
      </section>


      <section className="mt-8">
        <SalesPeriodChart
          series={dashboard.series}
          metric={dashboard.period.metric}
          period={dashboard.period}
          basePath={basePath}
        />
      </section>


      <section className="mt-6">
        <ProductRankingPanel
          ranking={dashboard.ranking}
          metric={dashboard.period.metric}
          period={dashboard.period}
          basePath={basePath}
        />
      </section>


      <section className="mt-8 grid gap-6 xl:grid-cols-[0.9fr_1.4fr]">
        <DailyRevenueBars
          days={
            last14Days.map(
              (day) => ({
                date:
                  day.date,

                grossRevenue:
                  day.grossRevenue,

                paidOrders:
                  day.paidOrders,

                unitsSold:
                  day.unitsSold,
              }),
            )
          }
        />


        <TopProductsTable
          products={
            topProducts
          }
        />
      </section>


      <section className="mt-8 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-gray-950">
              Qualidade dos dados
            </p>

            <p className="mt-1 text-xs text-gray-500">
              Percentual das unidades vendidas que já estão vinculadas a um SKU canônico.
            </p>
          </div>


          <div className="text-right">
            <p className="text-2xl font-bold text-gray-950">
              {last30Days.unitsSold >
              0
                ? (
                    (
                      last30Days.mappedUnits /
                      last30Days.unitsSold
                    ) *
                    100
                  ).toFixed(
                    1,
                  )
                : "0.0"}
              %
            </p>

            <p className="mt-1 text-xs text-gray-500">
              {integer.format(
                last30Days.unmappedUnits,
              )}{" "}
              unidades sem vínculo
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}