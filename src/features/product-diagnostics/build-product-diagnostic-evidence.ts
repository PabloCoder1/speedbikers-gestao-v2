import "server-only";

import { getProductStockIntelligence } from "@/features/stock/get-product-stock-intelligence";
import {
  buildProductDiagnosticEvidence,
  resolveProductDiagnosticAsOfDate,
  type ProductDiagnosticRawFacts,
} from "@/features/product-diagnostics/product-diagnostic-domain";
import { saoPauloDateKey } from "@/lib/date/sao-paulo";
import { createAdminClient } from "@/lib/supabase/admin";
import { measureServerOperation } from "@/lib/observability/measure-server-operation";

function numberOrZero(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function buildProductDiagnosticEvidenceForProduct(options: {
  organizationId: string;
  productId: string;
  allowedMlAccountIds: string[];
}) {
  return measureServerOperation("build_product_diagnostic_evidence", () => buildImpl(options));
}

async function buildImpl(options: { organizationId: string; productId: string; allowedMlAccountIds: string[] }) {
  const admin = createAdminClient();
  const asOfDate = resolveProductDiagnosticAsOfDate(saoPauloDateKey());

  const [stockIntelligence, evidenceRpc] = await Promise.all([
    getProductStockIntelligence(options.productId, {
      organizationId: options.organizationId,
      allowedMlAccountIds: options.allowedMlAccountIds,
    }),
    admin.rpc("get_product_diagnostic_evidence", {
      target_organization_id: options.organizationId,
      target_product_id: options.productId,
      as_of_date: asOfDate,
    }),
  ]);

  if (!stockIntelligence) return null;
  if (evidenceRpc.error) throw new Error(`PRODUCT_DIAGNOSTIC_EVIDENCE_RPC_FAILED:${evidenceRpc.error.message}`);

  const rpcData = (evidenceRpc.data ?? {}) as Record<string, unknown>;
  const sourceSkuKey = typeof rpcData.sourceSkuKey === "string" ? rpcData.sourceSkuKey : null;

  const planningResponse = sourceSkuKey
    ? await admin.rpc("get_purchase_planning_signal_for_sku", {
        target_organization_id: options.organizationId,
        target_source_sku_key: sourceSkuKey,
      })
    : null;
  if (planningResponse?.error) throw new Error(`PRODUCT_DIAGNOSTIC_PLANNING_RPC_FAILED:${planningResponse.error.message}`);
  const planningData = (planningResponse?.data ?? null) as Record<string, unknown> | null;

  const accountCodeByMlAccountId: Record<string, string> = {};
  for (const account of (rpcData.salesByAccount as Array<Record<string, unknown>> | undefined) ?? []) {
    const id = String(account.mlAccountId ?? "");
    const code = typeof account.accountCode === "string" ? account.accountCode : null;
    if (id && code) accountCodeByMlAccountId[id] = code;
  }
  for (const account of stockIntelligence.full.accounts ?? []) {
    if (account.accountId && account.code) accountCodeByMlAccountId[account.accountId] = account.code;
  }

  const salesRaw = (rpcData.sales ?? {}) as Record<string, unknown>;

  const raw: ProductDiagnosticRawFacts = {
    asOfDate,
    product: { id: stockIntelligence.product.id, sku: stockIntelligence.product.sku, name: stockIntelligence.product.name },
    sales: {
      units7: numberOrZero(salesRaw.units7),
      previousUnits7: numberOrZero(salesRaw.previous_units7),
      revenue7: numberOrZero(salesRaw.revenue7),
      previousRevenue7: numberOrZero(salesRaw.previous_revenue7),
      orders7: numberOrZero(salesRaw.orders7),
      previousOrders7: numberOrZero(salesRaw.previous_orders7),
      units30: numberOrZero(salesRaw.units30),
      previousUnits30: numberOrZero(salesRaw.previous_units30),
      revenue30: numberOrZero(salesRaw.revenue30),
      previousRevenue30: numberOrZero(salesRaw.previous_revenue30),
      orders30: numberOrZero(salesRaw.orders30),
      previousOrders30: numberOrZero(salesRaw.previous_orders30),
      units90: numberOrZero(salesRaw.units90),
      daysWithSales7: numberOrZero(salesRaw.days_with_sales7),
      daysWithSales30: numberOrZero(salesRaw.days_with_sales30),
      lastSaleDate: typeof salesRaw.last_sale_date === "string" ? salesRaw.last_sale_date : null,
    },
    salesByAccount: ((rpcData.salesByAccount as Array<Record<string, unknown>> | undefined) ?? []).map((account) => ({
      mlAccountId: String(account.mlAccountId ?? ""),
      accountCode: typeof account.accountCode === "string" ? account.accountCode : null,
      accountDisplayName: typeof account.accountDisplayName === "string" ? account.accountDisplayName : null,
      units7: numberOrZero(account.units7),
      previousUnits7: numberOrZero(account.previousUnits7),
      units30: numberOrZero(account.units30),
      previousUnits30: numberOrZero(account.previousUnits30),
      revenue30: numberOrZero(account.revenue30),
      orders30: numberOrZero(account.orders30),
    })),
    salesCoverageReady: Boolean(rpcData.salesCoverageReady),
    salesCoverageFrom: String(rpcData.salesCoverageFrom ?? asOfDate),
    salesCoverageTo: String(rpcData.salesCoverageTo ?? asOfDate),
    priceEvents: ((rpcData.priceEvents as Array<Record<string, unknown>> | undefined) ?? []).map((event) => ({
      type: "PRICE_EFFECTIVE_CHANGED" as const,
      occurredAt: String(event.occurredAt),
      mlAccountId: String(event.mlAccountId ?? ""),
      itemId: String(event.itemId ?? ""),
      before: numberOrNull(event.before),
      after: numberOrNull(event.after),
      percentageChange: numberOrNull(event.percentageChange),
    })),
    promotionEvents: ((rpcData.promotionEvents as Array<Record<string, unknown>> | undefined) ?? []).map((event) => ({
      type: event.type as "PROMOTION_STARTED" | "PROMOTION_ENDED" | "PROMOTION_CHANGED",
      occurredAt: String(event.occurredAt),
      mlAccountId: String(event.mlAccountId ?? ""),
      itemId: String(event.itemId ?? ""),
      promotionId: typeof event.promotionId === "string" ? event.promotionId : null,
      promotionName: typeof event.promotionName === "string" ? event.promotionName : null,
      promotionStatus: typeof event.promotionStatus === "string" ? event.promotionStatus : null,
      promotionStartedAt: typeof event.promotionStartedAt === "string" ? event.promotionStartedAt : null,
      promotionEndsAt: typeof event.promotionEndsAt === "string" ? event.promotionEndsAt : null,
    })),
    priceHistoryFrom: typeof rpcData.priceHistoryFrom === "string" ? rpcData.priceHistoryFrom : null,
    priceHistoryTo: typeof rpcData.priceHistoryTo === "string" ? rpcData.priceHistoryTo : null,
    priceCheckedAt: typeof rpcData.priceCheckedAt === "string" ? rpcData.priceCheckedAt : null,
    fullEvents: ((rpcData.fullEvents as Array<Record<string, unknown>> | undefined) ?? []).map((event) => ({
      type: event.type as "FULL_ZERO" | "FULL_RESTORED" | "FULL_DROP",
      occurredAt: String(event.occurredAt),
      mlAccountId: String(event.mlAccountId ?? ""),
      inventoryId: String(event.inventoryId ?? ""),
      before: numberOrNull(event.before),
      after: numberOrNull(event.after),
    })),
    fullHistoryFrom: typeof rpcData.fullHistoryFrom === "string" ? rpcData.fullHistoryFrom : null,
    fullHistoryTo: typeof rpcData.fullHistoryTo === "string" ? rpcData.fullHistoryTo : null,
    fullCurrent: {
      applicable: stockIntelligence.full.applicable,
      ready: stockIntelligence.full.ready,
      available: numberOrNull(stockIntelligence.full.available),
      total: numberOrNull(stockIntelligence.full.total),
      coverageDays: numberOrNull(stockIntelligence.full.coverageDays),
      checkedAt: stockIntelligence.full.checkedAt,
    },
    physicalCurrent: {
      applicable: Boolean(stockIntelligence.physical.applicable),
      ready: Boolean(stockIntelligence.physical.ready),
      available: numberOrNull(stockIntelligence.physical.available),
      current: numberOrNull(stockIntelligence.physical.current),
      coverageDays: numberOrNull((stockIntelligence.physical as { coverageDays?: unknown }).coverageDays),
      checkedAt: (stockIntelligence.physical as { checkedAt?: string | null }).checkedAt ?? null,
    },
    advertised: {
      listingCount: stockIntelligence.advertised.listingCount,
      activeListingCount: stockIntelligence.advertised.activeListingCount,
    },
    mappingStatus: (typeof rpcData.mappingStatus === "string" ? rpcData.mappingStatus : "missing") as "linked" | "conflict" | "missing",
    planning: planningData
      ? {
          suggestedPurchaseQuantity: numberOrNull(planningData.suggestedPurchaseQuantity),
          purchasePlanningStatus: typeof planningData.purchasePlanningStatus === "string" ? planningData.purchasePlanningStatus : null,
          coverageDays: numberOrNull(planningData.coverageDays),
          leadTimeDays: numberOrNull(planningData.leadTimeDays),
        }
      : null,
    alerts: ((rpcData.alerts as Array<Record<string, unknown>> | undefined) ?? []).map((alert) => ({
      alertType: String(alert.alertType ?? ""),
      severity: String(alert.severity ?? ""),
      suggestedActionCode: typeof alert.suggestedActionCode === "string" ? alert.suggestedActionCode : null,
      firstSeenAt: String(alert.firstSeenAt),
      lastSeenAt: String(alert.lastSeenAt),
    })),
    openPurchaseOrders: ((rpcData.openPurchaseOrders as Array<Record<string, unknown>> | undefined) ?? []).map((po) => ({
      purchaseOrderId: String(po.purchaseOrderId ?? ""),
      orderNumber: String(po.orderNumber ?? ""),
      status: String(po.status ?? ""),
      expectedAt: typeof po.expectedAt === "string" ? po.expectedAt : null,
      quantityOrdered: numberOrZero(po.quantityOrdered),
      outstandingQuantity: numberOrZero(po.outstandingQuantity),
    })),
    accountCodeByMlAccountId,
  };

  const built = buildProductDiagnosticEvidence(raw);
  return { ...built, raw };
}
