import { redirect } from "next/navigation";

import { DailyRevenueBars } from "@/components/dashboard/daily-revenue-bars";
import { DashboardMetricCard } from "@/components/dashboard/dashboard-metric-card";
import { TopProductsTable } from "@/components/dashboard/top-products-table";
import { getDashboardOverview } from "@/features/dashboard/get-dashboard-overview";


export const metadata = {
  title:
    "Visão Geral",
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


export default async function DashboardPage() {
  const dashboard =
    await getDashboardOverview();


  if (!dashboard) {
    redirect(
      "/login",
    );
  }


  const {
    todayMetric,
    yesterdayMetric,
    soldSkuCount,
    last7Days,
    last30Days,
    last14Days,
    topProducts,
  } = dashboard;


  const revenueVariation =
    percentageChange(
      todayMetric.grossRevenue,
      yesterdayMetric.grossRevenue,
    );


  const ordersVariation =
    percentageChange(
      todayMetric.paidOrders,
      yesterdayMetric.paidOrders,
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
      <div className="mb-8">
        <p className="text-sm font-medium text-gray-500">
          Speed Bikers
        </p>

        <div className="mt-1 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-gray-950">
              Visão Geral
            </h1>

            <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
              Desempenho comercial consolidado das contas Mercado Livre disponíveis para o seu acesso.
            </p>
          </div>


          <div className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs text-gray-500">
            Atualização baseada nas sincronizações automáticas
          </div>
        </div>
      </div>


      <section>
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-gray-950">
            Hoje
          </h2>
        </div>


        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <DashboardMetricCard
            label="Pedidos pagos"
            value={
              integer.format(
                todayMetric.paidOrders,
              )
            }
            variation={
              ordersVariation
            }
            helper="Comparação com ontem"
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
            )} unidades · inclui hoje`}
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
            )} vendas · inclui hoje`}
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