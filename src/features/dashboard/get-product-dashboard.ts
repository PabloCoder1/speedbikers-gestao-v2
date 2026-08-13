import "server-only";

import {
  getCurrentAccess,
} from "@/features/auth/get-current-access";
import {
  createClient,
} from "@/lib/supabase/server";


type ProductRow = {
  id: string;
  sku: string;
  sku_key: string;
  name: string | null;
};


type AccountRow = {
  id: string;
  code: string;
  display_name: string;
  seller_id: string | null;
  nickname: string | null;
};


type ProductMetricRow = {
  ml_account_id: string;
  metric_date: string;

  orders_count: number;
  units_sold: number;

  gross_revenue:
    | number
    | string;

  sale_fees:
    | number
    | string;

  net_after_sale_fee:
    | number
    | string;

  average_unit_price:
    | number
    | string;
};


type DailyProductMetric = {
  date: string;

  ordersCount: number;
  unitsSold: number;

  grossRevenue: number;
  saleFees: number;
  netAfterSaleFee: number;
};


function numeric(
  value:
    | number
    | string
    | null
    | undefined,
) {
  const parsed =
    Number(
      value ?? 0,
    );

  return Number.isFinite(
    parsed,
  )
    ? parsed
    : 0;
}


const saoPauloFormatter =
  new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone:
        "America/Sao_Paulo",

      year:
        "numeric",

      month:
        "2-digit",

      day:
        "2-digit",
    },
  );


function getSaoPauloToday() {
  const parts =
    saoPauloFormatter
      .formatToParts(
        new Date(),
      );

  const values =
    new Map(
      parts.map(
        (part) => [
          part.type,
          part.value,
        ],
      ),
    );

  return [
    values.get("year"),
    values.get("month"),
    values.get("day"),
  ].join("-");
}


function shiftDate(
  dateKey: string,
  days: number,
) {
  const [
    year,
    month,
    day,
  ] =
    dateKey
      .split("-")
      .map(Number);

  const date =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day,
      ),
    );

  date.setUTCDate(
    date.getUTCDate() +
      days,
  );

  return date
    .toISOString()
    .slice(
      0,
      10,
    );
}


function emptyDay(
  date: string,
): DailyProductMetric {
  return {
    date,

    ordersCount:
      0,

    unitsSold:
      0,

    grossRevenue:
      0,

    saleFees:
      0,

    netAfterSaleFee:
      0,
  };
}


export async function getProductDashboard({
  productId,
}: {
  productId: string;
}) {
  const access =
    await getCurrentAccess();

  if (!access) {
    return null;
  }

  const supabase =
    await createClient();


  // ----------------------------------------------------------
  // PRODUCT
  // ----------------------------------------------------------

  const {
    data:
      productData,
    error:
      productError,
  } = await supabase
    .from(
      "products",
    )
    .select(
      [
        "id",
        "sku",
        "sku_key",
        "name",
      ].join(","),
    )
    .eq(
      "organization_id",
      access.organizationId,
    )
    .eq(
      "id",
      productId,
    )
    .maybeSingle<ProductRow>();


  if (productError) {
    throw new Error(
      "Não foi possível carregar o produto.",
    );
  }


  if (!productData) {
    return {
      access,

      found:
        false as const,
    };
  }


  // ----------------------------------------------------------
  // DATE RANGE
  //
  // Mantemos a mesma convenção utilizada atualmente
  // pelo dashboard principal:
  //
  // hoje - 30 até hoje, inclusive.
  // ----------------------------------------------------------

  const today =
    getSaoPauloToday();

  const thirtyDaysAgo =
    shiftDate(
      today,
      -30,
    );


  // ----------------------------------------------------------
  // AVAILABLE ACCOUNTS
  //
  // Esta consulta respeita RLS.
  // ----------------------------------------------------------

  const {
    data:
      accountRows,
    error:
      accountsError,
  } = await supabase
    .from(
      "ml_accounts",
    )
    .select(
      [
        "id",
        "code",
        "display_name",
        "seller_id",
        "nickname",
      ].join(","),
    )
    .eq(
      "organization_id",
      access.organizationId,
    )
    .eq(
      "is_active",
      true,
    )
    .order(
      "display_name",
      {
        ascending:
          true,
      },
    )
    .returns<
      AccountRow[]
    >();


  if (accountsError) {
    throw new Error(
      "Não foi possível carregar as contas do produto.",
    );
  }


  const accounts =
    accountRows ??
    [];


  // ----------------------------------------------------------
  // DAILY PRODUCT METRICS
  //
  // RLS também limita automaticamente às contas
  // permitidas para o usuário atual.
  // ----------------------------------------------------------

  const {
    data:
      metricRows,
    error:
      metricsError,
  } = await supabase
    .from(
      "daily_product_metrics",
    )
    .select(
      [
        "ml_account_id",
        "metric_date",
        "orders_count",
        "units_sold",
        "gross_revenue",
        "sale_fees",
        "net_after_sale_fee",
        "average_unit_price",
      ].join(","),
    )
    .eq(
      "organization_id",
      access.organizationId,
    )
    .eq(
      "product_id",
      productData.id,
    )
    .gte(
      "metric_date",
      thirtyDaysAgo,
    )
    .lte(
      "metric_date",
      today,
    )
    .order(
      "metric_date",
      {
        ascending:
          true,
      },
    )
    .returns<
      ProductMetricRow[]
    >();


  if (metricsError) {
    throw new Error(
      "Não foi possível carregar as métricas do produto.",
    );
  }


  const metrics =
    metricRows ??
    [];


  // ----------------------------------------------------------
  // DAILY CONSOLIDATED
  // ----------------------------------------------------------

  const dailyMap =
    new Map<
      string,
      DailyProductMetric
    >();


  for (
    const row
    of metrics
  ) {
    const current =
      dailyMap.get(
        row.metric_date,
      ) ??
      emptyDay(
        row.metric_date,
      );


    current.ordersCount +=
      row.orders_count;

    current.unitsSold +=
      row.units_sold;

    current.grossRevenue +=
      numeric(
        row.gross_revenue,
      );

    current.saleFees +=
      numeric(
        row.sale_fees,
      );

    current.netAfterSaleFee +=
      numeric(
        row.net_after_sale_fee,
      );


    dailyMap.set(
      row.metric_date,
      current,
    );
  }


  const daily:
    DailyProductMetric[] =
    [];


  for (
    let offset = -30;
    offset <= 0;
    offset += 1
  ) {
    const date =
      shiftDate(
        today,
        offset,
      );

    daily.push(
      dailyMap.get(
        date,
      ) ??
        emptyDay(
          date,
        ),
    );
  }


  // ----------------------------------------------------------
  // CONSOLIDATED SUMMARY
  // ----------------------------------------------------------

  const summary =
    metrics.reduce(
      (
        total,
        row,
      ) => ({
        ordersCount:
          total.ordersCount +
          row.orders_count,

        unitsSold:
          total.unitsSold +
          row.units_sold,

        grossRevenue:
          total.grossRevenue +
          numeric(
            row.gross_revenue,
          ),

        saleFees:
          total.saleFees +
          numeric(
            row.sale_fees,
          ),

        netAfterSaleFee:
          total.netAfterSaleFee +
          numeric(
            row.net_after_sale_fee,
          ),
      }),

      {
        ordersCount:
          0,

        unitsSold:
          0,

        grossRevenue:
          0,

        saleFees:
          0,

        netAfterSaleFee:
          0,
      },
    );


  const averageUnitPrice =
    summary.unitsSold > 0
      ? (
          summary
            .grossRevenue /
          summary
            .unitsSold
        )
      : 0;


  // ----------------------------------------------------------
  // BREAKDOWN BY ACCOUNT
  // ----------------------------------------------------------

  const accountMetrics =
    accounts.map(
      (account) => {
        const rows =
          metrics.filter(
            (metric) =>
              metric
                .ml_account_id ===
              account.id,
          );


        const totals =
          rows.reduce(
            (
              total,
              row,
            ) => ({
              ordersCount:
                total
                  .ordersCount +
                row
                  .orders_count,

              unitsSold:
                total
                  .unitsSold +
                row
                  .units_sold,

              grossRevenue:
                total
                  .grossRevenue +
                numeric(
                  row
                    .gross_revenue,
                ),

              saleFees:
                total
                  .saleFees +
                numeric(
                  row
                    .sale_fees,
                ),

              netAfterSaleFee:
                total
                  .netAfterSaleFee +
                numeric(
                  row
                    .net_after_sale_fee,
                ),
            }),

            {
              ordersCount:
                0,

              unitsSold:
                0,

              grossRevenue:
                0,

              saleFees:
                0,

              netAfterSaleFee:
                0,
            },
          );


        return {
          id:
            account.id,

          code:
            account.code,

          displayName:
            account
              .display_name,

          sellerId:
            account
              .seller_id,

          nickname:
            account.nickname,

          ordersCount:
            totals
              .ordersCount,

          unitsSold:
            totals
              .unitsSold,

          grossRevenue:
            totals
              .grossRevenue,

          saleFees:
            totals
              .saleFees,

          netAfterSaleFee:
            totals
              .netAfterSaleFee,

          averageUnitPrice:
            totals
              .unitsSold > 0
              ? (
                  totals
                    .grossRevenue /
                  totals
                    .unitsSold
                )
              : 0,
        };
      },
    );


  return {
    access,

    found:
      true as const,

    product: {
      id:
        productData.id,

      sku:
        productData.sku,

      skuKey:
        productData.sku_key,

      name:
        productData.name,
    },

    period: {
      from:
        thirtyDaysAgo,

      to:
        today,
    },

    summary: {
      ...summary,

      averageUnitPrice,
    },

    daily,

    accounts:
      accountMetrics,
  };
}
