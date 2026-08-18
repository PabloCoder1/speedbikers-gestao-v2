import "server-only";

import { getCurrentAccess } from "@/features/auth/get-current-access";
import {
  calculatePurchaseRecommendation,
  type PurchaseRecommendationStatus,
} from "@/features/stock/stock-domain";
import { measureServerOperation } from "@/lib/observability/measure-server-operation";
import { createClient } from "@/lib/supabase/server";

export type PurchasePlanningFilter =
  | "all"
  | "purchase"
  | "urgent"
  | "covered"
  | "no_sales"
  | "insufficient_data"
  | "imported"
  | "domestic";

export const PURCHASE_PAGE_SIZE = 100;

type PurchaseRow = {
  sourceSku: string;
  sourceSkuKey: string;
  title: string | null;
  brand: string | null;
  physicalAvailable: number | string | null;
  physicalCurrent: number | string | null;
  occupiedQuantity: number | string | null;
  purchaseInTransit: number | string | null;
  transferInTransit: number | string | null;
  lowStockThreshold: number | string | null;
  directUnitsSold30: number | string | null;
  kitUnitsConsumed30: number | string | null;
  physicalUnitsConsumed30: number | string | null;
  avgDailySales30: number | string | null;
  salesVelocityReady: boolean;
  coverageDays: number | string | null;
  leadTimeDays: number | string | null;
  demandDuringLeadTime: number | string | null;
  targetReserve: number | string | null;
  projectedStockAtArrival: number | string | null;
  suggestedPurchaseQuantity: number | string | null;
  status: PurchaseRecommendationStatus;
  planningIssue: string | null;
  sourceProductsCount: number | string | null;
  sourceProductIds: string[] | null;
  unitCost: number | string | null;
  estimatedPurchaseValue: number | string | null;
  updatedAt: string | null;
};

export type PurchasePlanningItem = {
  sourceSku: string;
  sourceSkuKey: string;
  title: string | null;
  brand: string | null;
  physicalAvailable: number | null;
  physicalCurrent: number | null;
  occupiedQuantity: number | null;
  purchaseInTransit: number;
  transferInTransit: number;
  lowStockThreshold: number | null;
  directUnitsSold30: number;
  kitUnitsConsumed30: number;
  physicalUnitsConsumed30: number;
  avgDailySales30: number | null;
  salesVelocityReady: boolean;
  coverageDays: number | null;
  leadTimeDays: number;
  demandDuringLeadTime: number | null;
  targetReserve: number;
  projectedStockAtArrival: number | null;
  suggestedPurchaseQuantity: number | null;
  status: PurchaseRecommendationStatus;
  planningIssue: string | null;
  sourceProductsCount: number;
  sourceProductIds: string[];
  unitCost: number | null;
  estimatedPurchaseValue: number | null;
  consumesViaKits: boolean;
};

export type PurchasePlanningOverview = {
  summary: {
    monitoredSkus: number;
    needPurchase: number;
    urgent: number;
    suggestedUnits: number;
    estimatedPurchaseValue: number;
    skusWithoutCost: number;
    insufficientData: number;
    mappingIssues: number;
    periodFrom: string | null;
    periodTo: string | null;
  };
  items: PurchasePlanningItem[];
  matchCount: number;
  pageSize: number;
};

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrZero(value: unknown) {
  return numberOrNull(value) ?? 0;
}

export async function getPurchasePlanning(
  params: {
    filter?: PurchasePlanningFilter;
    query?: string;
  } = {},
): Promise<PurchasePlanningOverview | null> {
  return measureServerOperation("get_purchase_planning", () =>
    getPurchasePlanningImpl(params),
  );
}

async function getPurchasePlanningImpl({
  filter = "all",
  query = "",
}: {
  filter?: PurchasePlanningFilter;
  query?: string;
} = {}): Promise<PurchasePlanningOverview | null> {
  const access = await getCurrentAccess();
  if (!access) return null;

  const supabase = await createClient();

  /*
   * Summary e página são independentes e cada uma percorre o mesmo
   * conjunto de sinais. Emiti-las em paralelo faz o tempo de parede ser o
   * da mais lenta, e não a soma das duas.
   */
  const [summaryResult, pageResult] = await Promise.all([
    supabase.rpc("get_purchase_planning_summary", {
      target_organization_id: access.organizationId,
    }),
    supabase.rpc("get_purchase_planning_page", {
      target_organization_id: access.organizationId,
      search_query: query.trim(),
      status_filter: filter,
      result_limit: PURCHASE_PAGE_SIZE,
      result_offset: 0,
    }),
  ]);

  if (summaryResult.error || pageResult.error) {
    throw new Error(
      `PURCHASE_PLANNING_READ_MODEL_FAILED:${
        summaryResult.error?.message ?? pageResult.error?.message ?? "empty_result"
      }`,
    );
  }

  const summaryModel = (summaryResult.data ?? {}) as Record<string, unknown>;
  const pageModel = (pageResult.data ?? {}) as {
    items?: PurchaseRow[];
    matchCount?: number;
  };

  const items = (pageModel.items ?? []).map((row): PurchasePlanningItem => {
    const physicalAvailable = numberOrNull(row.physicalAvailable);
    const purchaseInTransit = numberOrZero(row.purchaseInTransit);
    const lowStockThreshold = numberOrNull(row.lowStockThreshold);
    const avgDailySales30 = numberOrNull(row.avgDailySales30);
    const leadTimeDays = numberOrNull(row.leadTimeDays) ?? 15;

    /*
     * O SQL já calculou a sugestão — precisa disso para filtrar, ordenar e
     * paginar antes do LIMIT. Aqui recalculamos com a função pura coberta
     * por teste, de modo que o número exibido ao usuário venha sempre do
     * código verificado. Ambos aplicam a mesma fórmula documentada.
     */
    const recommendation = calculatePurchaseRecommendation({
      physicalAvailable,
      purchaseInTransit,
      lowStockThreshold,
      avgDailySales30,
      salesVelocityReady: row.salesVelocityReady === true,
      leadTimeDays,
      mappingReliable: row.planningIssue === null,
    });

    const kitUnitsConsumed30 = numberOrZero(row.kitUnitsConsumed30);

    return {
      sourceSku: row.sourceSku,
      sourceSkuKey: row.sourceSkuKey,
      title: row.title,
      brand: row.brand,
      physicalAvailable,
      physicalCurrent: numberOrNull(row.physicalCurrent),
      occupiedQuantity: numberOrNull(row.occupiedQuantity),
      purchaseInTransit,
      transferInTransit: numberOrZero(row.transferInTransit),
      lowStockThreshold,
      directUnitsSold30: numberOrZero(row.directUnitsSold30),
      kitUnitsConsumed30,
      physicalUnitsConsumed30: numberOrZero(row.physicalUnitsConsumed30),
      avgDailySales30,
      salesVelocityReady: row.salesVelocityReady === true,
      coverageDays: recommendation.coverageDays,
      leadTimeDays: recommendation.leadTimeDays,
      demandDuringLeadTime: recommendation.demandDuringLeadTime,
      targetReserve: recommendation.targetReserve,
      projectedStockAtArrival: recommendation.projectedStockAtArrival,
      suggestedPurchaseQuantity: recommendation.suggestedPurchaseQuantity,
      status: recommendation.status,
      planningIssue: row.planningIssue,
      sourceProductsCount: numberOrZero(row.sourceProductsCount),
      sourceProductIds: row.sourceProductIds ?? [],
      unitCost: numberOrNull(row.unitCost),
      estimatedPurchaseValue: numberOrNull(row.estimatedPurchaseValue),
      consumesViaKits: kitUnitsConsumed30 > 0,
    };
  });

  return {
    summary: {
      monitoredSkus: numberOrZero(summaryModel.monitoredSkus),
      needPurchase: numberOrZero(summaryModel.needPurchase),
      urgent: numberOrZero(summaryModel.urgent),
      suggestedUnits: numberOrZero(summaryModel.suggestedUnits),
      estimatedPurchaseValue: numberOrZero(summaryModel.estimatedPurchaseValue),
      skusWithoutCost: numberOrZero(summaryModel.skusWithoutCost),
      insufficientData: numberOrZero(summaryModel.insufficientData),
      mappingIssues: numberOrZero(summaryModel.mappingIssues),
      periodFrom: typeof summaryModel.periodFrom === "string" ? summaryModel.periodFrom : null,
      periodTo: typeof summaryModel.periodTo === "string" ? summaryModel.periodTo : null,
    },
    items,
    matchCount: numberOrZero(pageModel.matchCount),
    pageSize: PURCHASE_PAGE_SIZE,
  };
}
