import { createHash } from "node:crypto";

import { shiftSaoPauloDateKey } from "@/lib/date/sao-paulo";

export const PRODUCT_DIAGNOSTIC_EVIDENCE_VERSION = "product-evidence-v1";
export const PRODUCT_DIAGNOSTIC_EVIDENCE_VERSION_V2 = "product-evidence-v2";

/** Today's partial day is never included — as_of_date is always the last complete Sao Paulo day. */
export function resolveProductDiagnosticAsOfDate(todayDateKey: string): string {
  return shiftSaoPauloDateKey(todayDateKey, -1);
}

export type EvidenceCategory =
  | "sales"
  | "price"
  | "promotion"
  | "full"
  | "stock"
  | "listing"
  | "alert"
  | "purchase"
  | "mapping"
  | "coverage";

export type Evidence = {
  id: string;
  category: EvidenceCategory;
  label: string;
  value: unknown;
  displayText: string;
  occurredAt: string | null;
  source: string;
};

export type SalesTrigger =
  | "NO_SALES_7D"
  | "SALES_DROP_7D"
  | "SALES_DROP_30D"
  | "GROWTH"
  | "STABLE"
  | "INSUFFICIENT_DATA";

export type AccountSalesRaw = {
  mlAccountId: string;
  accountCode: string | null;
  accountDisplayName: string | null;
  units7: number;
  previousUnits7: number;
  units30: number;
  previousUnits30: number;
  revenue30: number;
  orders30: number;
};

export type PriceEventRaw = {
  type: "PRICE_EFFECTIVE_CHANGED";
  occurredAt: string;
  mlAccountId: string;
  itemId: string;
  before: number | null;
  after: number | null;
  percentageChange: number | null;
};

export type PromotionEventRaw = {
  type: "PROMOTION_STARTED" | "PROMOTION_ENDED" | "PROMOTION_CHANGED";
  occurredAt: string;
  mlAccountId: string;
  itemId: string;
  promotionId: string | null;
  promotionName: string | null;
  promotionStatus: string | null;
  promotionStartedAt: string | null;
  promotionEndsAt: string | null;
};

export type FullEventRaw = {
  type: "FULL_ZERO" | "FULL_RESTORED" | "FULL_DROP";
  occurredAt: string;
  mlAccountId: string;
  inventoryId: string;
  before: number | null;
  after: number | null;
};

export type AlertRaw = {
  alertType: string;
  severity: string;
  suggestedActionCode: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type OpenPurchaseOrderRaw = {
  purchaseOrderId: string;
  orderNumber: string;
  status: string;
  expectedAt: string | null;
  quantityOrdered: number;
  outstandingQuantity: number;
};

export type ProductDiagnosticRawFacts = {
  asOfDate: string;
  product: { id: string; sku: string; name: string };
  sales: {
    units7: number;
    previousUnits7: number;
    revenue7: number;
    previousRevenue7: number;
    orders7: number;
    previousOrders7: number;
    units30: number;
    previousUnits30: number;
    revenue30: number;
    previousRevenue30: number;
    orders30: number;
    previousOrders30: number;
    units90: number;
    daysWithSales7: number;
    daysWithSales30: number;
    lastSaleDate: string | null;
  };
  salesByAccount: AccountSalesRaw[];
  salesCoverageReady: boolean;
  salesCoverageFrom: string;
  salesCoverageTo: string;
  priceEvents: PriceEventRaw[];
  promotionEvents: PromotionEventRaw[];
  priceHistoryFrom: string | null;
  priceHistoryTo: string | null;
  priceCheckedAt: string | null;
  fullEvents: FullEventRaw[];
  fullHistoryFrom: string | null;
  fullHistoryTo: string | null;
  fullCurrent: {
    applicable: boolean;
    ready: boolean;
    available: number | null;
    total: number | null;
    coverageDays: number | null;
    checkedAt: string | null;
  };
  physicalCurrent: {
    applicable: boolean;
    ready: boolean;
    available: number | null;
    current: number | null;
    coverageDays: number | null;
    checkedAt: string | null;
  };
  advertised: {
    listingCount: number;
    activeListingCount: number;
  };
  mappingStatus: "linked" | "conflict" | "missing";
  planning: {
    suggestedPurchaseQuantity: number | null;
    purchasePlanningStatus: string | null;
    coverageDays: number | null;
    leadTimeDays: number | null;
  } | null;
  alerts: AlertRaw[];
  openPurchaseOrders: OpenPurchaseOrderRaw[];
  accountCodeByMlAccountId: Record<string, string>;
};

export type ProductDiagnosticComputedFacts = {
  sales: {
    delta7Units: number | null;
    delta7Revenue: number | null;
    delta30Units: number | null;
    delta30Revenue: number | null;
    trigger: SalesTrigger;
  };
  accountSpecificDropCodes: string[];
};

const numberFormatter = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const currencyFormatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateFormatter = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" });

function formatDate(iso: string | null) {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return dateFormatter.format(parsed);
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

/** force=true always calls Anthropic again; otherwise an existing succeeded run for the same evidence hash is reused. */
export function resolveDiagnosticCacheDecision(params: { hasCachedSuccess: boolean; force: boolean }): "use_cache" | "call_anthropic" {
  if (params.force) return "call_anthropic";
  return params.hasCachedSuccess ? "use_cache" : "call_anthropic";
}

/** previous = 0 never divides — returns null so it is never rendered as an invented infinite percentage. */
export function computeDeltaPercentage(current: number, previous: number): number | null {
  if (previous > 0) return round2(((current - previous) / previous) * 100);
  return null;
}

export function classifySalesTrigger(input: {
  units7: number;
  previousUnits7: number;
  units30: number;
  previousUnits30: number;
  salesCoverageReady: boolean;
}): SalesTrigger {
  if (!input.salesCoverageReady) return "INSUFFICIENT_DATA";
  const { units7, previousUnits7, units30, previousUnits30 } = input;

  if (units7 === 0 && previousUnits7 > 0) return "NO_SALES_7D";

  if (previousUnits7 >= 3 && units7 < previousUnits7) {
    const drop7 = (previousUnits7 - units7) / previousUnits7;
    if (drop7 >= 0.3) return "SALES_DROP_7D";
  }

  if (previousUnits30 >= 5 && units30 < previousUnits30) {
    const drop30 = (previousUnits30 - units30) / previousUnits30;
    if (drop30 >= 0.3) return "SALES_DROP_30D";
  }

  if (previousUnits30 > 0 && units30 > previousUnits30) return "GROWTH";

  return "STABLE";
}

/** An account counts as a concentrated drop only when the overall product trigger is not already a drop. */
export function detectAccountSpecificDropCodes(
  accounts: AccountSalesRaw[],
  overallTrigger: SalesTrigger,
): string[] {
  if (overallTrigger === "SALES_DROP_7D" || overallTrigger === "SALES_DROP_30D" || overallTrigger === "NO_SALES_7D") {
    return [];
  }
  return accounts
    .filter((account) => account.accountCode && account.previousUnits7 >= 3 && account.units7 < account.previousUnits7)
    .filter((account) => (account.previousUnits7 - account.units7) / account.previousUnits7 >= 0.3)
    .map((account) => account.accountCode as string);
}

class EvidenceCollector {
  private readonly items: Evidence[] = [];
  private readonly usedIds = new Set<string>();

  push(item: Omit<Evidence, "id"> & { id: string }) {
    let id = item.id;
    let suffix = 2;
    while (this.usedIds.has(id)) {
      id = `${item.id}#${suffix}`;
      suffix += 1;
    }
    this.usedIds.add(id);
    this.items.push({ ...item, id });
  }

  all() {
    return this.items;
  }
}

/**
 * Reusable so V2 can hash the combined evidence set (V1 evidence + market +
 * external + vision) — if any market price/status changes, the hash
 * changes and a diagnostic built on the old evidence is correctly flagged
 * stale, per Parte "Hash" in the ETAPA 36 spec.
 */
export function computeEvidenceHash(evidence: Evidence[]): string {
  return createHash("sha256")
    .update(JSON.stringify(evidence.map((item) => [item.id, item.category, item.value, item.occurredAt, item.source])))
    .digest("hex");
}

function normalizePromotionId(value: string | null) {
  return value === "" ? null : value;
}

export function buildProductDiagnosticEvidence(raw: ProductDiagnosticRawFacts): {
  evidence: Evidence[];
  facts: ProductDiagnosticComputedFacts;
  evidenceHash: string;
} {
  const collector = new EvidenceCollector();
  const accountCode = (mlAccountId: string) => raw.accountCodeByMlAccountId[mlAccountId] ?? mlAccountId;

  // --- Sales (Parte A) ---
  const delta7Units = computeDeltaPercentage(raw.sales.units7, raw.sales.previousUnits7);
  const delta7Revenue = computeDeltaPercentage(raw.sales.revenue7, raw.sales.previousRevenue7);
  const delta30Units = computeDeltaPercentage(raw.sales.units30, raw.sales.previousUnits30);
  const delta30Revenue = computeDeltaPercentage(raw.sales.revenue30, raw.sales.previousRevenue30);
  const trigger = classifySalesTrigger({
    units7: raw.sales.units7,
    previousUnits7: raw.sales.previousUnits7,
    units30: raw.sales.units30,
    previousUnits30: raw.sales.previousUnits30,
    salesCoverageReady: raw.salesCoverageReady,
  });

  collector.push({
    id: "sales.last7.units", category: "sales", label: "Unidades vendidas (ultimos 7 dias)",
    value: raw.sales.units7, displayText: `${numberFormatter.format(raw.sales.units7)} unidades nos ultimos 7 dias`,
    occurredAt: raw.salesCoverageTo, source: "daily_product_metrics",
  });
  collector.push({
    id: "sales.previous7.units", category: "sales", label: "Unidades vendidas (7 dias anteriores)",
    value: raw.sales.previousUnits7, displayText: `${numberFormatter.format(raw.sales.previousUnits7)} unidades nos 7 dias anteriores`,
    occurredAt: null, source: "daily_product_metrics",
  });
  collector.push({
    id: "sales.delta7.units", category: "sales", label: "Variacao de unidades (7 dias)",
    value: delta7Units,
    displayText: delta7Units === null ? "Sem base de comparacao (7 dias anteriores sem vendas)" : `${delta7Units >= 0 ? "↑" : "↓"} ${Math.abs(delta7Units)}% unidades vs. 7 dias anteriores`,
    occurredAt: null, source: "daily_product_metrics",
  });
  collector.push({
    id: "sales.delta7.revenue", category: "sales", label: "Variacao de receita (7 dias)",
    value: delta7Revenue,
    displayText: delta7Revenue === null ? "Sem base de comparacao de receita (7 dias anteriores)" : `${delta7Revenue >= 0 ? "↑" : "↓"} ${Math.abs(delta7Revenue)}% receita vs. 7 dias anteriores`,
    occurredAt: null, source: "daily_product_metrics",
  });
  collector.push({
    id: "sales.last30.units", category: "sales", label: "Unidades vendidas (ultimos 30 dias)",
    value: raw.sales.units30, displayText: `${numberFormatter.format(raw.sales.units30)} unidades nos ultimos 30 dias`,
    occurredAt: raw.salesCoverageTo, source: "daily_product_metrics",
  });
  collector.push({
    id: "sales.delta30.units", category: "sales", label: "Variacao de unidades (30 dias)",
    value: delta30Units,
    displayText: delta30Units === null ? "Sem base de comparacao (30 dias anteriores sem vendas)" : `${delta30Units >= 0 ? "↑" : "↓"} ${Math.abs(delta30Units)}% unidades vs. 30 dias anteriores`,
    occurredAt: null, source: "daily_product_metrics",
  });
  collector.push({
    id: "sales.delta30.revenue", category: "sales", label: "Variacao de receita (30 dias)",
    value: delta30Revenue, displayText: delta30Revenue === null ? "Sem base de comparacao de receita (30 dias anteriores)" : `${delta30Revenue >= 0 ? "↑" : "↓"} ${Math.abs(delta30Revenue)}% receita vs. 30 dias anteriores`,
    occurredAt: null, source: "daily_product_metrics",
  });
  collector.push({
    id: "sales.last90.units", category: "sales", label: "Unidades vendidas (ultimos 90 dias)",
    value: raw.sales.units90, displayText: `${numberFormatter.format(raw.sales.units90)} unidades nos ultimos 90 dias`,
    occurredAt: raw.salesCoverageTo, source: "daily_product_metrics",
  });
  collector.push({
    id: "sales.last_sale_date", category: "sales", label: "Ultima venda registrada",
    value: raw.sales.lastSaleDate, displayText: raw.sales.lastSaleDate ? `Ultima venda em ${formatDate(raw.sales.lastSaleDate)}` : "Nenhuma venda nos ultimos 90 dias",
    occurredAt: raw.sales.lastSaleDate, source: "daily_product_metrics",
  });
  collector.push({
    id: "sales.trigger", category: "sales", label: "Classificacao determinística de vendas",
    value: trigger, displayText: `Classificacao do sistema: ${trigger}`,
    occurredAt: null, source: "daily_product_metrics",
  });

  // --- Account breakdown ---
  const accountSpecificDropCodes = detectAccountSpecificDropCodes(raw.salesByAccount, trigger);
  for (const account of raw.salesByAccount) {
    const code = account.accountCode ?? account.mlAccountId;
    const accountDelta7 = computeDeltaPercentage(account.units7, account.previousUnits7);
    const accountDelta30 = computeDeltaPercentage(account.units30, account.previousUnits30);
    collector.push({
      id: `sales.account.${code}.units7`, category: "sales", label: `Unidades (7 dias) - conta ${code}`,
      value: account.units7, displayText: `${numberFormatter.format(account.units7)} unidades (7 dias) na conta ${account.accountDisplayName ?? code}`,
      occurredAt: raw.salesCoverageTo, source: "daily_product_metrics",
    });
    collector.push({
      id: `sales.account.${code}.delta7`, category: "sales", label: `Variacao (7 dias) - conta ${code}`,
      value: accountDelta7,
      displayText: accountDelta7 === null
        ? `Sem base de comparacao na conta ${code} (7 dias)`
        : `${accountDelta7 >= 0 ? "↑" : "↓"} ${Math.abs(accountDelta7)}% na conta ${account.accountDisplayName ?? code} (7 dias)${accountSpecificDropCodes.includes(code) ? " - queda concentrada nesta conta" : ""}`,
      occurredAt: null, source: "daily_product_metrics",
    });
    collector.push({
      id: `sales.account.${code}.units30`, category: "sales", label: `Unidades (30 dias) - conta ${code}`,
      value: account.units30, displayText: `${numberFormatter.format(account.units30)} unidades (30 dias) na conta ${account.accountDisplayName ?? code}`,
      occurredAt: raw.salesCoverageTo, source: "daily_product_metrics",
    });
    collector.push({
      id: `sales.account.${code}.delta30`, category: "sales", label: `Variacao (30 dias) - conta ${code}`,
      value: accountDelta30, displayText: accountDelta30 === null
        ? `Sem base de comparacao na conta ${code} (30 dias)`
        : `${accountDelta30 >= 0 ? "↑" : "↓"} ${Math.abs(accountDelta30)}% na conta ${account.accountDisplayName ?? code} (30 dias)`,
      occurredAt: null, source: "daily_product_metrics",
    });
  }
  if (accountSpecificDropCodes.length > 0) {
    collector.push({
      id: "sales.account_specific_drop", category: "sales", label: "Queda concentrada em conta especifica",
      value: accountSpecificDropCodes,
      displayText: `Queda concentrada na(s) conta(s): ${accountSpecificDropCodes.join(", ")} - as demais contas nao mostram o mesmo padrao`,
      occurredAt: null, source: "daily_product_metrics",
    });
  }

  // --- Price events (Parte B) ---
  for (const event of raw.priceEvents) {
    const code = accountCode(event.mlAccountId);
    const dateKey = event.occurredAt.slice(0, 10);
    collector.push({
      id: `price.${code}.${event.itemId}.${dateKey}`, category: "price",
      label: `Alteracao de preco efetivo - ${event.itemId} (${code})`,
      value: { before: event.before, after: event.after, percentageChange: event.percentageChange },
      displayText: `Preco final na conta ${code} (${event.itemId}): ${event.before !== null ? currencyFormatter.format(event.before) : "?"} -> ${event.after !== null ? currencyFormatter.format(event.after) : "?"} em ${formatDate(event.occurredAt)}`,
      occurredAt: event.occurredAt, source: "ml_offer_price_state_snapshots",
    });
  }

  // --- Promotion events ---
  for (const event of raw.promotionEvents) {
    const code = accountCode(event.mlAccountId);
    const dateKey = event.occurredAt.slice(0, 10);
    const promotionId = normalizePromotionId(event.promotionId);
    const typeLabel = event.type === "PROMOTION_STARTED" ? "iniciada" : event.type === "PROMOTION_ENDED" ? "encerrada" : "alterada";
    collector.push({
      id: `promotion.${code}.${event.itemId}.${event.type.toLowerCase()}.${dateKey}`, category: "promotion",
      label: `Promocao ${typeLabel} - ${event.itemId} (${code})`,
      value: { promotionId, promotionName: event.promotionName, promotionStatus: event.promotionStatus },
      displayText: `Promocao ${typeLabel} na conta ${code} (${event.itemId}) em ${formatDate(event.occurredAt)}${event.promotionName ? ` - ${event.promotionName}` : ""}`,
      occurredAt: event.occurredAt, source: "ml_offer_price_state_snapshots",
    });
  }

  // --- Full events (Parte C) ---
  for (const event of raw.fullEvents) {
    const code = accountCode(event.mlAccountId);
    const dateKey = event.occurredAt.slice(0, 10);
    const typeLabel = event.type === "FULL_ZERO" ? "zerou" : event.type === "FULL_RESTORED" ? "foi reposto" : "caiu";
    collector.push({
      id: `full.${code}.${event.inventoryId}.${event.type.toLowerCase()}.${dateKey}`, category: "full",
      label: `Full ${typeLabel} - ${event.inventoryId} (${code})`,
      value: { before: event.before, after: event.after },
      displayText: `Full na conta ${code} (${event.inventoryId}) ${typeLabel}: ${event.before} -> ${event.after} em ${formatDate(event.occurredAt)}`,
      occurredAt: event.occurredAt, source: "ml_fulfillment_stock_snapshots",
    });
  }
  collector.push({
    id: "full.current.available", category: "full", label: "Full atual (disponivel)",
    value: raw.fullCurrent.available,
    displayText: raw.fullCurrent.applicable ? `Full atual = ${raw.fullCurrent.available ?? "?"}` : "Produto nao aplicavel a Full",
    occurredAt: raw.fullCurrent.checkedAt, source: "ml_fulfillment_stock_states",
  });

  // --- Physical stock (Parte D) ---
  collector.push({
    id: "stock.physical.current", category: "stock", label: "Estoque fisico atual (fotografia UpSeller)",
    value: raw.physicalCurrent.available,
    displayText: raw.physicalCurrent.applicable ? `Estoque fisico: ${raw.physicalCurrent.available ?? "?"} (fato atual, sem historico de ruptura comprovado)` : "Sem mapeamento fisico ativo",
    occurredAt: raw.physicalCurrent.checkedAt, source: "upseller_stock",
  });

  // --- Listings (Parte E) ---
  collector.push({
    id: "listing.active_count", category: "listing", label: "Anuncios ativos",
    value: raw.advertised.activeListingCount,
    displayText: raw.advertised.activeListingCount > 0
      ? `${raw.advertised.activeListingCount} anuncio(s) ativo(s) de ${raw.advertised.listingCount} total`
      : "Nenhum anuncio ativo (HAS_ACTIVE_OFFER = false)",
    occurredAt: null, source: "listing_state",
  });
  if (raw.advertised.listingCount > 0 && raw.advertised.activeListingCount === 0) {
    collector.push({
      id: "listing.all_offers_inactive", category: "listing", label: "Todos os anuncios inativos",
      value: true, displayText: "ALL_OFFERS_INACTIVE: nenhum anuncio deste produto esta ativo",
      occurredAt: null, source: "listing_state",
    });
  }

  // --- Alerts (Parte F) ---
  for (const alert of raw.alerts) {
    collector.push({
      id: `alert.${alert.alertType}.${alert.firstSeenAt.slice(0, 10)}`, category: "alert",
      label: `Alerta operacional: ${alert.alertType}`,
      value: { severity: alert.severity, suggestedActionCode: alert.suggestedActionCode },
      displayText: `Alerta ${alert.alertType} (${alert.severity}) aberto desde ${formatDate(alert.firstSeenAt)}`,
      occurredAt: alert.firstSeenAt, source: "operational_alert",
    });
  }

  // --- Purchase (Parte G) ---
  if (raw.planning) {
    collector.push({
      id: "purchase.suggested_quantity", category: "purchase", label: "Quantidade sugerida de compra",
      value: raw.planning.suggestedPurchaseQuantity,
      displayText: raw.planning.suggestedPurchaseQuantity !== null ? `Sugestao de compra: ${raw.planning.suggestedPurchaseQuantity} unidades` : "Sugestao de compra indisponivel",
      occurredAt: null, source: "purchase_planning",
    });
    collector.push({
      id: "purchase.planning_status", category: "purchase", label: "Status do planejamento de compra",
      value: raw.planning.purchasePlanningStatus,
      displayText: `Status de planejamento: ${raw.planning.purchasePlanningStatus ?? "indisponivel"}`,
      occurredAt: null, source: "purchase_planning",
    });
  }
  for (const po of raw.openPurchaseOrders) {
    collector.push({
      id: `purchase.open_order.${po.orderNumber}`, category: "purchase", label: `Pedido de compra em aberto ${po.orderNumber}`,
      value: { status: po.status, outstandingQuantity: po.outstandingQuantity, expectedAt: po.expectedAt },
      displayText: `${po.orderNumber} (${po.status}): ${po.outstandingQuantity} unidades em transito${po.expectedAt ? `, previsao ${formatDate(po.expectedAt)}` : ""}`,
      occurredAt: null, source: "purchase_planning",
    });
  }

  // --- Mapping (Parte H) ---
  collector.push({
    id: "mapping.status", category: "mapping", label: "Status do mapeamento de estoque",
    value: raw.mappingStatus,
    displayText: raw.mappingStatus === "conflict"
      ? "INVENTORY_MAPPING_CONFLICT: conclusoes de estoque fisico sao limitadas"
      : raw.mappingStatus === "missing"
        ? "INVENTORY_MAPPING_MISSING: sem mapeamento fisico, conclusoes de estoque sao limitadas"
        : "Mapeamento de estoque ativo (linked)",
    occurredAt: null, source: "listing_state",
  });

  // --- Coverage (Parte I) ---
  collector.push({
    id: "coverage.sales_ready", category: "coverage", label: "Cobertura de historico de vendas",
    value: raw.salesCoverageReady,
    displayText: raw.salesCoverageReady ? `Historico de vendas cobre de ${formatDate(raw.salesCoverageFrom)} a ${formatDate(raw.salesCoverageTo)}` : "Historico de vendas incompleto para o periodo analisado",
    occurredAt: null, source: "daily_product_metrics",
  });

  const evidence = collector.all();
  const evidenceHash = computeEvidenceHash(evidence);

  return {
    evidence,
    facts: {
      sales: { delta7Units, delta7Revenue, delta30Units, delta30Revenue, trigger },
      accountSpecificDropCodes,
    },
    evidenceHash,
  };
}
