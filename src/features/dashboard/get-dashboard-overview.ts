import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { createClient } from "@/lib/supabase/server";


type DailyAccountMetricRow = {
  metric_date: string;

  total_orders: number;

  paid_orders: number;

  cancelled_orders: number;

  units_sold: number;

  mapped_units: number;

  unmapped_units: number;

  gross_revenue: number | string;

  sale_fees: number | string;

  net_after_sale_fee: number | string;
};


type TopProductRow = {
  product_id: string;

  sku: string;

  product_name: string | null;

  orders_count: number;

  units_sold: number;

  gross_revenue: number | string;

  sale_fees: number | string;

  net_after_sale_fee: number | string;

  average_unit_price: number | string;
};


type DailyMetric = {
  date: string;

  totalOrders: number;

  paidOrders: number;

  cancelledOrders: number;

  unitsSold: number;

  mappedUnits: number;

  unmappedUnits: number;

  grossRevenue: number;

  saleFees: number;

  netAfterSaleFee: number;
};


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
  ] = dateKey
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
    .slice(0, 10);
}


function numeric(
  value:
    | number
    | string
    | null
    | undefined,
) {
  const parsed =
    Number(value ?? 0);


  return Number.isFinite(
    parsed,
  )
    ? parsed
    : 0;
}


function emptyDay(
  date: string,
): DailyMetric {
  return {
    date,

    totalOrders:
      0,

    paidOrders:
      0,

    cancelledOrders:
      0,

    unitsSold:
      0,

    mappedUnits:
      0,

    unmappedUnits:
      0,

    grossRevenue:
      0,

    saleFees:
      0,

    netAfterSaleFee:
      0,
  };
}


function sumPeriod(
  days: DailyMetric[],
) {
  return days.reduce(
    (
      total,
      day,
    ) => ({
      totalOrders:
        total.totalOrders +
        day.totalOrders,

      paidOrders:
        total.paidOrders +
        day.paidOrders,

      cancelledOrders:
        total.cancelledOrders +
        day.cancelledOrders,

      unitsSold:
        total.unitsSold +
        day.unitsSold,

      mappedUnits:
        total.mappedUnits +
        day.mappedUnits,

      unmappedUnits:
        total.unmappedUnits +
        day.unmappedUnits,

      grossRevenue:
        total.grossRevenue +
        day.grossRevenue,

      saleFees:
        total.saleFees +
        day.saleFees,

      netAfterSaleFee:
        total.netAfterSaleFee +
        day.netAfterSaleFee,
    }),
    {
      totalOrders: 0,
      paidOrders: 0,
      cancelledOrders: 0,
      unitsSold: 0,
      mappedUnits: 0,
      unmappedUnits: 0,
      grossRevenue: 0,
      saleFees: 0,
      netAfterSaleFee: 0,
    },
  );
}


export async function getDashboardOverview() {
  const access =
    await getCurrentAccess();


  if (!access) {
    return null;
  }


  const supabase =
    await createClient();


  const today =
    getSaoPauloToday();


  const yesterday =
    shiftDate(
      today,
      -1,
    );


  /*
   * Mercado Livre counts "últimos 7 dias" inclusively on both
   * ends: from today minus 7 up to today, which spans 8 calendar
   * dates. Matching that convention is what makes the period
   * cards reconcile with the seller dashboard.
   *
   * Today is included while still accumulating, so the cards
   * read live and only settle once the day closes.
   */
  const thirtyDaysAgo =
    shiftDate(
      today,
      -30,
    );


  const sevenDaysAgo =
    shiftDate(
      today,
      -7,
    );


  const fourteenDaysAgo =
    shiftDate(
      today,
      -13,
    );


  const {
    data:
      dailyRows,
    error:
      dailyError,
  } = await supabase
    .from(
      "daily_account_metrics",
    )
    .select(
      [
        "metric_date",
        "total_orders",
        "paid_orders",
        "cancelled_orders",
        "units_sold",
        "mapped_units",
        "unmapped_units",
        "gross_revenue",
        "sale_fees",
        "net_after_sale_fee",
      ].join(","),
    )
    .eq(
      "organization_id",
      access.organizationId,
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
        ascending: true,
      },
    );


  if (dailyError) {
    throw new Error(
      "Não foi possível carregar as métricas diárias do dashboard.",
    );
  }


  /*
   * Multiple accounts may have one row for
   * the same date, therefore aggregate them.
   */
  const dayMap =
    new Map<
      string,
      DailyMetric
    >();


  for (
    const rawRow
    of dailyRows ?? []
  ) {
    const row =
      rawRow as
        unknown as
        DailyAccountMetricRow;


    const current =
      dayMap.get(
        row.metric_date,
      ) ??
      emptyDay(
        row.metric_date,
      );


    current.totalOrders +=
      row.total_orders;

    current.paidOrders +=
      row.paid_orders;

    current.cancelledOrders +=
      row.cancelled_orders;

    current.unitsSold +=
      row.units_sold;

    current.mappedUnits +=
      row.mapped_units;

    current.unmappedUnits +=
      row.unmapped_units;

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


    dayMap.set(
      row.metric_date,
      current,
    );
  }


  const days:
    DailyMetric[] = [];


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


    days.push(
      dayMap.get(
        date,
      ) ??
      emptyDay(
        date,
      ),
    );
  }


  const todayMetric =
    dayMap.get(
      today,
    ) ??
    emptyDay(
      today,
    );


  const yesterdayMetric =
    dayMap.get(
      yesterday,
    ) ??
    emptyDay(
      yesterday,
    );


  const last7Days =
    sumPeriod(
      days.filter(
        (day) =>
          day.date >=
          sevenDaysAgo,
      ),
    );


  const last30Days =
    sumPeriod(
      days,
    );


  const last14Days =
    days.filter(
      (day) =>
        day.date >=
        fourteenDaysAgo,
    );


  /*
   * How many unique canonical SKUs
   * sold today?
   */
  const {
    data:
      soldProductsToday,
    error:
      soldProductsError,
  } = await supabase
    .from(
      "daily_product_metrics",
    )
    .select(
      "product_id",
    )
    .eq(
      "organization_id",
      access.organizationId,
    )
    .eq(
      "metric_date",
      today,
    )
    .gt(
      "units_sold",
      0,
    );


  if (
    soldProductsError
  ) {
    throw new Error(
      "Não foi possível carregar os produtos vendidos hoje.",
    );
  }


  const soldSkuCount =
    new Set(
      (
        soldProductsToday ??
        []
      ).map(
        (row) =>
          row.product_id,
      ),
    ).size;


  const {
    data:
      topProductsData,
    error:
      topProductsError,
  } = await supabase.rpc(
    "get_dashboard_top_products",
    {
      target_organization_id:
        access.organizationId,

      target_date_from:
        thirtyDaysAgo,

      target_date_to:
        today,

      target_limit:
        10,
    },
  );


  if (
    topProductsError
  ) {
    throw new Error(
      "Não foi possível carregar o ranking de produtos.",
    );
  }


  const topProducts =
    (
      topProductsData ??
      []
    ).map(
      (
        rawRow: unknown,
        index: number,
      ) => {
        const row =
          rawRow as
            TopProductRow;


        return {
          position:
            index + 1,

          productId:
            row.product_id,

          sku:
            row.sku,

          name:
            row.product_name,

          ordersCount:
            numeric(
              row.orders_count,
            ),

          unitsSold:
            numeric(
              row.units_sold,
            ),

          grossRevenue:
            numeric(
              row.gross_revenue,
            ),

          saleFees:
            numeric(
              row.sale_fees,
            ),

          netAfterSaleFee:
            numeric(
              row.net_after_sale_fee,
            ),

          averageUnitPrice:
            numeric(
              row.average_unit_price,
            ),
        };
      },
    );


  return {
    access,

    today,

    yesterday,

    todayMetric,

    yesterdayMetric,

    soldSkuCount,

    last7Days,

    last7DaysStart:
      sevenDaysAgo,

    last30Days,

    last30DaysStart:
      thirtyDaysAgo,

    last14Days,

    topProducts,
  };
}