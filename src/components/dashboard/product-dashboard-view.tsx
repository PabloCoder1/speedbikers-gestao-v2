import Link from "next/link";

import {
  DailyRevenueBars,
} from "@/components/dashboard/daily-revenue-bars";

import {
  DashboardMetricCard,
} from "@/components/dashboard/dashboard-metric-card";

import {
  ProductListingsPanel,
} from "@/components/dashboard/product-listings-panel";

import {
  ProductOfferHistoryPanel,
} from "@/components/dashboard/product-offer-history-panel";

import {
  ProductOperationalHealthPanel,
} from "@/components/dashboard/product-operational-health-panel";

import {
  ProductStockIntelligencePanel,
} from "@/components/dashboard/product-stock-intelligence-panel";

import {
  ProductDiagnosticsPanel,
} from "@/components/dashboard/product-diagnostics-panel";

import type {
  ProductDiagnosticRunRecord,
} from "@/features/product-diagnostics/get-product-diagnostic-latest";

import type {
  getProductDashboard,
} from "@/features/dashboard/get-product-dashboard";

import type {
  getProductListings,
} from "@/features/dashboard/get-product-listings";

import type {
  getProductOfferHistory,
} from "@/features/dashboard/get-product-offer-history";

import type {
  getProductStockIntelligence,
} from "@/features/stock/get-product-stock-intelligence";


type ProductDashboardResult =
  NonNullable<
    Awaited<
      ReturnType<
        typeof getProductDashboard
      >
    >
  >;


type ProductDashboard =
  Extract<
    ProductDashboardResult,
    {
      found: true;
    }
  >;


type ProductListings =
  Awaited<
    ReturnType<
      typeof getProductListings
    >
  >;


type ProductOfferHistory =
  Awaited<
    ReturnType<
      typeof getProductOfferHistory
    >
  >;


type ProductStockIntelligence =
  Awaited<
    ReturnType<
      typeof getProductStockIntelligence
    >
  >;


type ProductDashboardViewProps = {
  dashboard:
    ProductDashboard;

  productListings:
    ProductListings;

  offerHistory:
    ProductOfferHistory;

  stockIntelligence:
    ProductStockIntelligence;

  diagnosticsCanGenerate:
    boolean;

  latestDiagnostic:
    ProductDiagnosticRunRecord | null;

  isDiagnosticStale:
    boolean;
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


function formatDate(
  date: string,
) {
  return dayMonth.format(
    new Date(
      `${date}T12:00:00.000Z`,
    ),
  );
}


function formatPeriod(
  from: string,
  to: string,
) {
  return `${formatDate(
    from,
  )} a ${formatDate(
    to,
  )}`;
}


export function ProductDashboardView({
  dashboard,
  productListings,
  offerHistory,
  stockIntelligence,
  diagnosticsCanGenerate,
  latestDiagnostic,
  isDiagnosticStale,
}: ProductDashboardViewProps) {
  const {
    product,
    period,
    summary,
    daily,
    accounts,
  } = dashboard;


  const activeAccounts =
    accounts.filter(
      (account) =>
        account.ordersCount >
          0 ||
        account.unitsSold >
          0 ||
        account.grossRevenue >
          0,
    );


  return (
    <div className="mx-auto w-full max-w-[1500px]">

      {/* ======================================================
          HEADER
      ====================================================== */}

      <div className="mb-6">

        <Link
          href="/"
          className="text-sm font-medium text-gray-500 transition hover:text-gray-950"
        >
          ← Voltar ao dashboard
        </Link>


        <div className="mt-5 flex flex-wrap items-end justify-between gap-4">

          <div>

            <p className="text-sm font-medium text-gray-500">
              Dashboard do produto
            </p>


            <h1 className="mt-1 text-3xl font-bold tracking-tight text-gray-950">
              {product.sku}
            </h1>


            <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-500">
              {product.name ??
                "Produto sem nome cadastrado"}
            </p>


            <p className="mt-2 text-xs text-gray-400">
              SKU canônico · análise consolidada entre as contas disponíveis
            </p>

          </div>


          <div className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs text-gray-500">
            {formatPeriod(
              period.from,
              period.to,
            )}
          </div>

        </div>

      </div>


      {/* ======================================================
          SUMMARY
      ====================================================== */}

      <section>

        <div className="mb-3">

          <h2 className="text-sm font-semibold text-gray-950">
            Desempenho
          </h2>

          <p className="mt-1 text-xs text-gray-500">
            Resultado consolidado do SKU no período
          </p>

        </div>


        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">

          <DashboardMetricCard
            label="Faturamento"
            value={
              currency.format(
                summary.grossRevenue,
              )
            }
            helper="Vendas brutas do SKU"
          />


          <DashboardMetricCard
            label="Vendas"
            value={
              integer.format(
                summary.ordersCount,
              )
            }
            helper="Quantidade de vendas"
          />


          <DashboardMetricCard
            label="Unidades vendidas"
            value={
              integer.format(
                summary.unitsSold,
              )
            }
            helper="Quantidade total de unidades"
          />


          <DashboardMetricCard
            label="Preço médio"
            value={
              currency.format(
                summary.averageUnitPrice,
              )
            }
            helper="Faturamento ÷ unidades"
          />


          <DashboardMetricCard
            label="Após taxa de venda"
            value={
              currency.format(
                summary.netAfterSaleFee,
              )
            }
            helper="Ainda não representa lucro líquido"
          />

        </div>

      </section>


      {/* ======================================================
          EVOLUTION + ACCOUNTS
      ====================================================== */}

      <section className="mt-8 grid gap-6 xl:grid-cols-[1fr_1.35fr]">

        <DailyRevenueBars
          days={
            daily
              .slice(
                -14,
              )
              .map(
                (day) => ({
                  date:
                    day.date,

                  grossRevenue:
                    day.grossRevenue,

                  /*
                   * O componente atual ainda possui
                   * esta propriedade com o nome antigo.
                   * Ela não é exibida visualmente.
                   */
                  paidOrders:
                    day.ordersCount,

                  unitsSold:
                    day.unitsSold,
                }),
              )
          }
        />


        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">

          <div className="border-b border-gray-100 p-5">

            <p className="text-sm font-semibold text-gray-950">
              Desempenho por conta
            </p>

            <p className="mt-1 text-xs text-gray-500">
              Participação do SKU em cada conta Mercado Livre
            </p>

          </div>


          {accounts.length ===
          0 ? (

            <div className="p-8 text-center text-sm text-gray-500">
              Nenhuma conta disponível.
            </div>

          ) : (

            <div className="overflow-x-auto">

              <table className="w-full min-w-[720px] text-left">

                <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-400">

                  <tr>

                    <th className="px-5 py-3">
                      Conta
                    </th>

                    <th className="px-5 py-3 text-right">
                      Vendas
                    </th>

                    <th className="px-5 py-3 text-right">
                      Unidades
                    </th>

                    <th className="px-5 py-3 text-right">
                      Faturamento
                    </th>

                    <th className="px-5 py-3 text-right">
                      Preço médio
                    </th>

                  </tr>

                </thead>


                <tbody className="divide-y divide-gray-100">

                  {accounts.map(
                    (account) => {

                      const hasSales =
                        account.ordersCount >
                          0 ||
                        account.unitsSold >
                          0 ||
                        account.grossRevenue >
                          0;


                      return (

                        <tr
                          key={
                            account.id
                          }
                          className="text-sm"
                        >

                          <td className="px-5 py-4">

                            <Link
                              href={`/conta/${account.code}`}
                              className="font-semibold text-gray-950 transition hover:text-gray-500"
                            >
                              {
                                account.displayName
                              }
                            </Link>


                            {account.nickname ? (

                              <p className="mt-1 text-xs text-gray-400">
                                {
                                  account.nickname
                                }
                              </p>

                            ) : null}

                          </td>


                          <td className="px-5 py-4 text-right font-medium text-gray-700">

                            {hasSales
                              ? integer.format(
                                  account.ordersCount,
                                )
                              : "—"}

                          </td>


                          <td className="px-5 py-4 text-right font-medium text-gray-700">

                            {hasSales
                              ? integer.format(
                                  account.unitsSold,
                                )
                              : "—"}

                          </td>


                          <td className="px-5 py-4 text-right font-semibold text-gray-950">

                            {hasSales
                              ? currency.format(
                                  account.grossRevenue,
                                )
                              : "—"}

                          </td>


                          <td className="px-5 py-4 text-right text-gray-700">

                            {hasSales
                              ? currency.format(
                                  account.averageUnitPrice,
                                )
                              : "—"}

                          </td>

                        </tr>

                      );

                    },
                  )}

                </tbody>

              </table>

            </div>

          )}

        </div>

      </section>


      {/* ======================================================
          COVERAGE
      ====================================================== */}

      <section className="mt-8 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">

        <div className="flex flex-wrap items-center justify-between gap-4">

          <div>

            <p className="text-sm font-semibold text-gray-950">
              Presença nas contas
            </p>

            <p className="mt-1 text-xs text-gray-500">
              Contas que registraram venda deste SKU no período analisado
            </p>

          </div>


          <div className="text-right">

            <p className="text-2xl font-bold tracking-tight text-gray-950">

              {
                activeAccounts.length
              }

              <span className="text-base font-medium text-gray-400">
                {" "}
                /{" "}
                {
                  accounts.length
                }
              </span>

            </p>

            <p className="mt-1 text-xs text-gray-500">
              contas com vendas
            </p>

          </div>

        </div>

      </section>


      <ProductStockIntelligencePanel
        data={
          stockIntelligence
        }
      />


      <ProductDiagnosticsPanel
        productId={
          product.id
        }
        canGenerate={
          diagnosticsCanGenerate
        }
        initialDiagnostic={
          latestDiagnostic
        }
        isStale={
          isDiagnosticStale
        }
      />


      <ProductOperationalHealthPanel
        data={
          productListings
        }
      />


      <ProductListingsPanel
        data={
          productListings
        }
      />


      <ProductOfferHistoryPanel
        data={
          offerHistory
        }
      />

    </div>
  );
}
