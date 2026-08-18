import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import { resolveDashboardPeriod } from "@/features/dashboard/resolve-dashboard-period";
import {
  saoPauloDateKey,
  shiftSaoPauloDateKey,
} from "@/lib/date/sao-paulo";
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


type DashboardAccountRow = {
  id: string;
  code: string;
  display_name: string;
  seller_id: string | null;
  nickname: string | null;
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


export type DashboardRankingMetric = "revenue" | "units" | "orders";

export const DASHBOARD_PERIOD_PRESETS = [7, 30, 90] as const;

export async function getDashboardOverview(
  {
    accountCode = null,
    periodDays = 30,
    dateFrom = null,
    dateTo = null,
    rankingMetric = "revenue",
    abcClass = null,
  }: {
    accountCode?: string | null;
    periodDays?: number;
    dateFrom?: string | null;
    dateTo?: string | null;
    rankingMetric?: DashboardRankingMetric;
    abcClass?: "A" | "B" | "C" | null;
  } = {},
) {
  const access =
    await getCurrentAccess();


  if (!access) {
    return null;
  }


  const supabase =
    await createClient();


  const normalizedAccountCode =
    accountCode
      ?.trim()
      .toLowerCase() ||
    null;

  const {
    data:
      availableAccountRows,
    error:
      availableAccountsError,
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
        ascending: true,
      },
    )
    .returns<DashboardAccountRow[]>();

  if (
    availableAccountsError
  ) {
    throw new Error(
      "Não foi possível carregar as contas disponíveis para o dashboard.",
    );
  }

  const availableAccounts =
    availableAccountRows ??
    [];

  const selectedAccount =
    normalizedAccountCode
      ? availableAccounts.find(
          (account) =>
            account.code ===
            normalizedAccountCode,
        ) ?? null
      : null;

  if (
    normalizedAccountCode &&
    !selectedAccount
  ) {
    throw new Error(
      "Conta Mercado Livre não encontrada ou sem permissão de acesso.",
    );
  }


  const today =
    saoPauloDateKey();


  const yesterday =
    shiftSaoPauloDateKey(
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
    shiftSaoPauloDateKey(
      today,
      -30,
    );


  const sevenDaysAgo =
    shiftSaoPauloDateKey(
      today,
      -7,
    );


  const fourteenDaysAgo =
    shiftSaoPauloDateKey(
      today,
      -13,
    );


  /*
   * Período do gráfico. Os presets contam dias completos anteriores a hoje
   * e incluem hoje ainda acumulando, na mesma convenção dos cards. Um
   * intervalo personalizado válido tem prioridade sobre o preset.
   */
  const resolvedPeriod = resolveDashboardPeriod({
    today,
    thirtyDaysAgo,
    periodDays,
    dateFrom,
    dateTo,
  });

  const periodFrom = resolvedPeriod.from;
  const periodTo = resolvedPeriod.to;
  const rangeStart = resolvedPeriod.rangeStart;

  const dailyMetricsQuery =
    supabase
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
        rangeStart,
      )
      .lte(
        "metric_date",
        today,
      );

  if (selectedAccount) {
    dailyMetricsQuery.eq(
      "ml_account_id",
      selectedAccount.id,
    );
  }


  /*
   * How many unique canonical SKUs
   * sold today?
   */
  const soldProductsQuery =
    supabase
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

  if (selectedAccount) {
    soldProductsQuery.eq(
      "ml_account_id",
      selectedAccount.id,
    );
  }


  const topProductsRequest =
    selectedAccount
      ? supabase.rpc(
          "get_dashboard_top_products_for_account",
          {
            target_organization_id:
              access.organizationId,

            target_ml_account_id:
              selectedAccount.id,

            target_date_from:
              thirtyDaysAgo,

            target_date_to:
              today,

            target_limit:
              10,
          },
        )
      : supabase.rpc(
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


  const rankingRequest = supabase.rpc(
    "get_dashboard_product_ranking",
    {
      target_organization_id: access.organizationId,
      target_date_from: periodFrom,
      target_date_to: periodTo,
      target_metric: rankingMetric,
      target_ml_account_id: selectedAccount?.id ?? null,
      target_limit: 50,
      target_abc_class: abcClass,
    },
  );

  /*
   * As consultas abaixo sao independentes entre si;
   * emiti-las juntas evita round-trips sequenciais
   * ao Supabase no carregamento do dashboard.
   */
  const [
    {
      data:
        dailyRows,
      error:
        dailyError,
    },
    {
      data:
        soldProductsToday,
      error:
        soldProductsError,
    },
    {
      data:
        topProductsData,
      error:
        topProductsError,
    },
    {
      data:
        rankingData,
      error:
        rankingError,
    },
  ] = await Promise.all([
    dailyMetricsQuery
      .order(
        "metric_date",
        {
          ascending: true,
        },
      ),

    soldProductsQuery,

    topProductsRequest,

    rankingRequest,
  ]);


  if (rankingError) {
    throw new Error(
      "Não foi possível carregar a curva ABC dos produtos.",
    );
  }


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
      shiftSaoPauloDateKey(
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

    availableAccounts:
      availableAccounts.map(
        (account) => ({
          id:
            account.id,

          code:
            account.code,

          displayName:
            account.display_name,

          sellerId:
            account.seller_id,

          nickname:
            account.nickname,
        }),
      ),

    selectedAccount:
      selectedAccount
        ? {
            id:
              selectedAccount.id,

            code:
              selectedAccount.code,

            displayName:
              selectedAccount
                .display_name,

            sellerId:
              selectedAccount
                .seller_id,

            nickname:
              selectedAccount.nickname,
          }
        : null,

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

    /*
     * Serie diaria do periodo escolhido, ja preenchida com dias sem venda
     * para o grafico nao "pular" datas.
     */
    period: {
      from: periodFrom,
      to: periodTo,
      days: resolvedPeriod.days,
      custom: resolvedPeriod.custom,
      metric: rankingMetric,
      abcClass,
    },

    series: buildSeries(dayMap, periodFrom, periodTo),

    ranking: normalizeRanking(rankingData),
  };
}


function buildSeries(
  dayMap: Map<string, DailyMetric>,
  from: string,
  to: string,
) {
  const series: DailyMetric[] = [];
  let cursor = from;
  // Teto defensivo: evita laco infinito se as datas vierem invertidas.
  for (let guard = 0; guard < 400 && cursor <= to; guard += 1) {
    series.push(dayMap.get(cursor) ?? emptyDay(cursor));
    cursor = shiftSaoPauloDateKey(cursor, 1);
  }
  return series;
}


type AbcClassRow = {
  abc_class: "A" | "B" | "C";
  products: number | string;
  metric_value: number | string;
  units_sold: number | string;
  gross_revenue: number | string;
  metric_share: number | string;
};

type RankingRow = {
  position: number;
  product_id: string;
  sku: string;
  product_name: string | null;
  abc_class: "A" | "B" | "C";
  units_sold: number | string;
  orders_count: number | string;
  gross_revenue: number | string;
  net_after_sale_fee: number | string;
  metric_value: number | string;
  metric_share: number | string;
  cumulative_share: number | string;
  average_unit_price: number | string | null;
};

function normalizeRanking(raw: unknown) {
  const model = (raw ?? {}) as {
    metric?: string;
    metricTotal?: number | string;
    rankedProducts?: number | string;
    listedProducts?: number | string;
    abc?: AbcClassRow[];
    top?: RankingRow[];
  };

  return {
    metricTotal: numeric(model.metricTotal),
    rankedProducts: numeric(model.rankedProducts),
    listedProducts: numeric(model.listedProducts),
    abc: (model.abc ?? []).map((row) => ({
      className: row.abc_class,
      products: numeric(row.products),
      metricValue: numeric(row.metric_value),
      unitsSold: numeric(row.units_sold),
      grossRevenue: numeric(row.gross_revenue),
      metricShare: numeric(row.metric_share),
    })),
    top: (model.top ?? []).map((row) => ({
      position: numeric(row.position),
      productId: row.product_id,
      sku: row.sku,
      name: row.product_name,
      abcClass: row.abc_class,
      unitsSold: numeric(row.units_sold),
      ordersCount: numeric(row.orders_count),
      grossRevenue: numeric(row.gross_revenue),
      netAfterSaleFee: numeric(row.net_after_sale_fee),
      metricValue: numeric(row.metric_value),
      metricShare: numeric(row.metric_share),
      cumulativeShare: numeric(row.cumulative_share),
      averageUnitPrice: numeric(row.average_unit_price),
    })),
  };
}