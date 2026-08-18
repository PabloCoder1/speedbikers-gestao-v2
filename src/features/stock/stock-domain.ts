import { createHash } from "node:crypto";

export type JsonRecord = Record<string, unknown>;

export function normalizeKey(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[（）﹙﹚［］【】{}()[\]]/g, " ")
    .replace(/[‐‑‒–—―−_/\\.,;:\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function normalizeSku(value: string) {
  return value.trim().toUpperCase();
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseDecimal(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  let text = value.trim().replace(/[^0-9,.-]/g, "");
  if (!text) return null;
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    text = comma > dot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (comma >= 0) {
    text = text.replace(/\./g, "").replace(",", ".");
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
  if (typeof value !== "string") return null;
  const key = normalizeKey(value);
  if (["SIM", "TRUE", "ATIVO", "ATIVA", "1"].includes(key)) return true;
  if (["NAO", "FALSE", "INATIVO", "INATIVA", "0"].includes(key)) return false;
  return null;
}

export function splitValues(value: unknown) {
  if (value === null || value === undefined || value === "") return [];
  return String(value)
    .split(/[\n\r,;|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export type StockMaterialState = {
  skuKey: string;
  warehouseKey: string;
  lowStockThreshold: number;
  purchaseInTransit: number;
  transferInTransit: number;
  occupiedQuantity: number;
  availableQuantity: number;
  currentQuantity: number;
  averageCost: number | null;
  stockValue: number | null;
};

export function stockStateHash(state: StockMaterialState) {
  return sha256(stableJson(state));
}

export function fulfillmentStateHash(state: {
  inventoryId: string;
  totalQuantity: number;
  availableQuantity: number;
  notAvailableQuantity: number;
  notAvailableDetail: unknown;
  externalReferences: unknown;
}) {
  return sha256(stableJson(state));
}

export type StoreClassification = {
  channel: "mercado_livre" | "shopee" | "kwai" | "temu" | "tiktok" | "unknown";
  accountCode: "speedbikers" | "offracer" | "sb" | "gmr" | null;
};

export function classifyStoreName(storeName: string): StoreClassification {
  const key = normalizeKey(storeName);
  const known: Record<string, StoreClassification["accountCode"]> = {
    "MERCADO ML SPEEDBIKERS LOJA 1": "speedbikers",
    "MERCADO ML SPEEDBIKERS LOJA 2": "offracer",
    "MERCADO ML SBMOTOS": "sb",
    "MERCADO ML GMR": "gmr",
  };
  if (key.startsWith("MERCADO ML")) return { channel: "mercado_livre", accountCode: known[key] ?? null };
  if (key.startsWith("SHOPEE")) return { channel: "shopee", accountCode: null };
  if (key.startsWith("KWAI")) return { channel: "kwai", accountCode: null };
  if (key.startsWith("TEMU")) return { channel: "temu", accountCode: null };
  if (key.startsWith("TIKTOK")) return { channel: "tiktok", accountCode: null };
  return { channel: "unknown", accountCode: null };
}

export type KitComponentRequirement = { skuKey: string; requiredQuantity: number };
export type ComponentWarehouseStock = { skuKey: string; warehouseKey: string; availableQuantity: number };

export function calculateKitAvailability(
  components: KitComponentRequirement[],
  stock: ComponentWarehouseStock[],
) {
  if (components.length === 0) {
    return { ready: false, available: null, warehouses: [], missingComponents: [], conflict: "empty_kit" } as const;
  }
  const componentKeys = new Set(components.map((component) => component.skuKey));
  const nested = components.some((component) => component.requiredQuantity <= 0);
  if (nested) {
    return { ready: false, available: null, warehouses: [], missingComponents: [], conflict: "invalid_requirement" } as const;
  }
  const missingComponents = [...componentKeys].filter(
    (skuKey) => !stock.some((row) => row.skuKey === skuKey),
  );
  if (missingComponents.length > 0) {
    return { ready: false, available: null, warehouses: [], missingComponents, conflict: null } as const;
  }

  const warehouseKeys = [...new Set(stock.map((row) => row.warehouseKey))];
  const warehouses: { warehouseKey: string; available: number }[] = [];
  for (const warehouseKey of warehouseKeys) {
    const capacities: number[] = [];
    for (const component of components) {
      const row = stock.find(
        (candidate) => candidate.warehouseKey === warehouseKey && candidate.skuKey === component.skuKey,
      );
      if (!row) {
        return {
          ready: false,
          available: null,
          warehouses: [],
          missingComponents: [component.skuKey],
          conflict: null,
        } as const;
      }
      capacities.push(Math.floor(row.availableQuantity / component.requiredQuantity));
    }
    warehouses.push({ warehouseKey, available: Math.min(...capacities) });
  }
  return {
    ready: true,
    available: warehouses.reduce((sum, warehouse) => sum + warehouse.available, 0),
    warehouses,
    missingComponents: [],
    conflict: null,
  } as const;
}

export function purchaseLeadTimeDays(brand: string | null | undefined) {
  const brandKey = normalizeKey(brand ?? "").replace(/\s+/g, "");
  return brandKey === "OFFRACER" || brandKey === "NAVETEC" ? 90 : 15;
}

export function calculateThirtyDaySalesVelocity(input: {
  unitsSold30: number;
  historyReady: boolean;
}) {
  const unitsSold30 = Number.isFinite(input.unitsSold30) && input.unitsSold30 > 0
    ? input.unitsSold30
    : 0;
  const avgDailySales30 = input.historyReady ? unitsSold30 / 30 : null;
  return {
    unitsSold30,
    avgDailySales30,
    salesVelocityReady: input.historyReady,
    noSales: input.historyReady && unitsSold30 === 0,
  };
}

export function calculateCoverageDays(
  available: number | null,
  avgDailySales30: number | null,
  salesVelocityReady: boolean,
) {
  if (!salesVelocityReady || available === null || avgDailySales30 === null || avgDailySales30 <= 0) {
    return null;
  }
  return available / avgDailySales30;
}

export type PurchaseRecommendationStatus =
  | "urgent"
  | "due"
  | "covered"
  | "no_sales"
  | "insufficient_data"
  | "mapping_issue";

export type PurchaseRecommendationReason =
  | "no_recent_sales"
  | "history_not_ready"
  | "mapping_issue"
  | null;

export type PurchaseRecommendation = {
  leadTimeDays: number;
  targetReserve: number;
  demandDuringLeadTime: number | null;
  projectedStockAtArrival: number | null;
  suggestedPurchaseQuantity: number | null;
  purchaseRequired: boolean;
  coverageDays: number | null;
  projectedCoverageAtArrival: number | null;
  status: PurchaseRecommendationStatus;
  reason: PurchaseRecommendationReason;
};

/*
 * Cálculo determinístico de reposição por SKU FÍSICO.
 *
 * A sugestão precisa cobrir a demanda que vai ocorrer enquanto a
 * mercadoria está a caminho, mais a reserva mínima configurada, menos o
 * que já existe disponível e o que já foi comprado e ainda não chegou:
 *
 *   demanda no lead time + reserva - disponível - compras em trânsito
 *
 * transfer_in_transit NÃO entra: é movimentação interna entre depósitos e
 * não há evidência suficiente de que consolidar warehouses não gere dupla
 * contagem. Full também não entra — físico e Full são pools separados.
 */
export function calculatePurchaseRecommendation(input: {
  physicalAvailable: number | null;
  purchaseInTransit: number | null;
  lowStockThreshold: number | null;
  avgDailySales30: number | null;
  salesVelocityReady: boolean;
  leadTimeDays: number;
  mappingReliable?: boolean;
}): PurchaseRecommendation {
  const leadTimeDays = Number.isFinite(input.leadTimeDays) && input.leadTimeDays > 0
    ? input.leadTimeDays
    : 0;

  // Sem threshold configurado a reserva é zero: não inventamos reserva.
  const targetReserve = Math.max(
    Number.isFinite(input.lowStockThreshold ?? NaN) ? (input.lowStockThreshold as number) : 0,
    0,
  );

  const available = Number.isFinite(input.physicalAvailable ?? NaN)
    ? (input.physicalAvailable as number)
    : null;
  const purchaseInTransit = Number.isFinite(input.purchaseInTransit ?? NaN)
    ? (input.purchaseInTransit as number)
    : 0;

  const empty = {
    leadTimeDays,
    targetReserve,
    demandDuringLeadTime: null,
    projectedStockAtArrival: null,
    suggestedPurchaseQuantity: null,
    purchaseRequired: false,
    coverageDays: null,
    projectedCoverageAtArrival: null,
  };

  if (input.mappingReliable === false) {
    return { ...empty, status: "mapping_issue", reason: "mapping_issue" };
  }

  // Sem cobertura comprovada de histórico não extrapolamos silenciosamente.
  if (input.salesVelocityReady !== true || available === null) {
    return { ...empty, status: "insufficient_data", reason: "history_not_ready" };
  }

  const avgDailySales30 = Number.isFinite(input.avgDailySales30 ?? NaN)
    ? (input.avgDailySales30 as number)
    : 0;

  if (avgDailySales30 <= 0) {
    return {
      leadTimeDays,
      targetReserve,
      demandDuringLeadTime: 0,
      projectedStockAtArrival: available + purchaseInTransit,
      suggestedPurchaseQuantity: 0,
      purchaseRequired: false,
      coverageDays: null,
      projectedCoverageAtArrival: null,
      status: "no_sales",
      reason: "no_recent_sales",
    };
  }

  const demandDuringLeadTime = avgDailySales30 * leadTimeDays;
  const projectedStockAtArrival = available + purchaseInTransit - demandDuringLeadTime;
  const rawSuggested =
    demandDuringLeadTime + targetReserve - available - purchaseInTransit;
  const suggestedPurchaseQuantity = Math.ceil(Math.max(0, rawSuggested));
  const purchaseRequired = suggestedPurchaseQuantity > 0;

  return {
    leadTimeDays,
    targetReserve,
    demandDuringLeadTime,
    projectedStockAtArrival,
    suggestedPurchaseQuantity,
    purchaseRequired,
    coverageDays: available / avgDailySales30,
    projectedCoverageAtArrival: projectedStockAtArrival / avgDailySales30,
    status: purchaseRequired
      ? (available <= 0 ? "urgent" : "due")
      : "covered",
    reason: null,
  };
}

export type PhysicalDemandContribution = {
  productId: string;
  sourceSkuKey: string;
  sourceKind: "simple" | "kit";
  unitsSold30: number;
};

export type PhysicalDemandKit = {
  kitSkuKey: string;
  components: KitComponentRequirement[];
  /*
   * false quando a composição não é confiável: componente faltando,
   * kit aninhado não suportado ou definição não resolvida.
   */
  reliable: boolean;
};

export type PhysicalDemandRow = {
  sourceSkuKey: string;
  directUnitsSold30: number;
  kitUnitsConsumed30: number;
  physicalUnitsConsumed30: number;
  contributingProductIds: string[];
  planningIssues: string[];
};

/*
 * Traduz vendas por product canônico em consumo por SKU FÍSICO.
 *
 * Regras que este cálculo precisa respeitar:
 *
 * - Vários products podem apontar para o mesmo source_sku_key; as vendas
 *   somam, e o SKU aparece uma única vez.
 * - Kit não é comprado: a demanda é distribuída entre os componentes,
 *   multiplicada pela quantidade requerida de cada um.
 * - Um componente pode ter venda direta E consumo via kit; os dois somam.
 * - Kit sem composição confiável não distribui demanda automaticamente:
 *   registra planningIssue e fica de fora da sugestão.
 * - O mesmo product nunca entra duas vezes na árvore.
 */
export function buildPhysicalDemand(
  contributions: PhysicalDemandContribution[],
  kits: PhysicalDemandKit[],
): PhysicalDemandRow[] {
  const kitByKey = new Map(kits.map((kit) => [kit.kitSkuKey, kit] as const));
  const rows = new Map<string, PhysicalDemandRow>();
  const seenProducts = new Set<string>();

  function rowFor(sourceSkuKey: string) {
    const existing = rows.get(sourceSkuKey);
    if (existing) return existing;
    const created: PhysicalDemandRow = {
      sourceSkuKey,
      directUnitsSold30: 0,
      kitUnitsConsumed30: 0,
      physicalUnitsConsumed30: 0,
      contributingProductIds: [],
      planningIssues: [],
    };
    rows.set(sourceSkuKey, created);
    return created;
  }

  for (const contribution of contributions) {
    // Um product contribui uma única vez para a árvore de demanda.
    if (seenProducts.has(contribution.productId)) continue;
    seenProducts.add(contribution.productId);

    const units = Number.isFinite(contribution.unitsSold30) && contribution.unitsSold30 > 0
      ? contribution.unitsSold30
      : 0;

    if (contribution.sourceKind === "simple") {
      const row = rowFor(contribution.sourceSkuKey);
      row.directUnitsSold30 += units;
      if (!row.contributingProductIds.includes(contribution.productId)) {
        row.contributingProductIds.push(contribution.productId);
      }
      continue;
    }

    const kit = kitByKey.get(contribution.sourceSkuKey);
    if (!kit || !kit.reliable || kit.components.length === 0) {
      /*
       * O kit em si não vira linha de compra — ele não tem estoque físico
       * próprio. Registramos o problema no SKU do kit para a tela poder
       * explicar por que aquela demanda não foi distribuída.
       */
      const row = rowFor(contribution.sourceSkuKey);
      if (!row.planningIssues.includes("kit_components_unknown")) {
        row.planningIssues.push("kit_components_unknown");
      }
      if (!row.contributingProductIds.includes(contribution.productId)) {
        row.contributingProductIds.push(contribution.productId);
      }
      continue;
    }

    for (const component of kit.components) {
      const row = rowFor(component.skuKey);
      row.kitUnitsConsumed30 += units * component.requiredQuantity;
      if (!row.contributingProductIds.includes(contribution.productId)) {
        row.contributingProductIds.push(contribution.productId);
      }
    }
  }

  for (const row of rows.values()) {
    row.physicalUnitsConsumed30 = row.directUnitsSold30 + row.kitUnitsConsumed30;
  }

  return [...rows.values()].sort((left, right) =>
    left.sourceSkuKey.localeCompare(right.sourceSkuKey),
  );
}

export type ReplenishmentAlertCandidate = {
  alertType: string;
  severity: "critical" | "warning" | "info";
  evidence: JsonRecord;
  suggestedActionCode: string;
  dedupeScope?: string;
};

export function buildReplenishmentAlerts(input: {
  sourceSku: string | null;
  brand: string | null;
  physicalReady: boolean;
  physicalAvailable: number | null;
  unitsSold30: number;
  avgDailySales30: number | null;
  salesVelocityReady: boolean;
  physicalCoverageDays: number | null;
  fullAccounts: {
    accountId: string;
    accountCode: string | null;
    accountName: string | null;
    inventoryCount: number;
    pendingInventoryCount: number;
    available: number;
    checkedAt: string | null;
  }[];
}) {
  const alerts: ReplenishmentAlertCandidate[] = [];
  if (!input.physicalReady || input.physicalAvailable === null) return alerts;

  const leadTime = purchaseLeadTimeDays(input.brand);
  const purchaseEvidence = {
    brand: input.brand,
    purchaseLeadTimeDays: leadTime,
    physicalAvailable: input.physicalAvailable,
    unitsSold30: input.unitsSold30,
    avgDailySales30: input.avgDailySales30,
    physicalCoverageDays: input.physicalCoverageDays,
  };

  if (input.physicalAvailable <= 0) {
    alerts.push({
      alertType: "PHYSICAL_OUT_OF_STOCK",
      severity: "critical",
      evidence: { sourceSku: input.sourceSku, physicalAvailable: input.physicalAvailable },
      suggestedActionCode: "review_physical_replenishment",
    });
    if (input.salesVelocityReady && input.avgDailySales30 !== null && input.avgDailySales30 > 0) {
      alerts.push({
        alertType: "PURCHASE_REPLENISHMENT_REQUIRED",
        severity: "critical",
        evidence: purchaseEvidence,
        suggestedActionCode: "create_purchase_replenishment",
      });
    }
    return alerts;
  }

  if (
    input.salesVelocityReady &&
    input.avgDailySales30 !== null &&
    input.avgDailySales30 > 0 &&
    input.physicalCoverageDays !== null &&
    input.physicalCoverageDays <= leadTime
  ) {
    alerts.push({
      alertType: "PURCHASE_REPLENISHMENT_DUE",
      severity: "warning",
      evidence: purchaseEvidence,
      suggestedActionCode: "create_purchase_replenishment",
    });
  }

  for (const account of input.fullAccounts) {
    if (account.inventoryCount === 0 || account.pendingInventoryCount > 0 || account.available !== 0) continue;
    alerts.push({
      alertType: "FULL_REPLENISH_FROM_PHYSICAL",
      severity: "warning",
      evidence: {
        physicalAvailable: input.physicalAvailable,
        fullAvailable: account.available,
        accountId: account.accountId,
        accountCode: account.accountCode,
        accountName: account.accountName,
        unitsSold30: input.salesVelocityReady ? input.unitsSold30 : null,
        avgDailySales30: input.salesVelocityReady ? input.avgDailySales30 : null,
      },
      suggestedActionCode: "replenish_full_from_physical",
      dedupeScope: `account:${account.accountId}`,
    });
  }
  return alerts;
}

export type InventoryLinkCandidate = {
  sourceSkuKey: string;
  priority: number;
  linkMethod: string;
};

/*
 * Desempate por SKU idêntico.
 *
 * Quando um produto tem vários candidatos de vínculo, mas exatamente UM
 * deles é igual ao próprio SKU do produto, esse é o vínculo — não há
 * ambiguidade real. É o caso de BAU98, cujos candidatos eram ATRT0311 e
 * BAU98.
 *
 * Exige exatamente um: se dois candidatos normalizarem para o mesmo SKU
 * do produto, a origem está inconsistente e a decisão volta a ser humana.
 */
export function resolveExactSkuCandidate(
  productSkuKey: string,
  candidates: InventoryLinkCandidate[],
) {
  const normalized = normalizeSku(productSkuKey);
  const exact = candidates.filter(
    (candidate) => normalizeSku(candidate.sourceSkuKey) === normalized,
  );
  return exact.length === 1 ? exact[0] : null;
}

export function chooseInventoryLink(
  manual: InventoryLinkCandidate | null,
  candidates: InventoryLinkCandidate[],
  productSkuKey?: string,
) {
  if (manual) return { status: "manual" as const, selected: manual };

  const sourceSkuKeys = [...new Set(candidates.map((candidate) => candidate.sourceSkuKey))].sort();
  if (sourceSkuKeys.length > 1) {
    const exact = productSkuKey
      ? resolveExactSkuCandidate(productSkuKey, candidates)
      : null;
    if (exact) return { status: "exact_sku" as const, selected: exact };
    return { status: "conflict" as const, selected: null };
  }
  const selected = [...candidates].sort((left, right) =>
    left.priority - right.priority ||
    left.sourceSkuKey.localeCompare(right.sourceSkuKey) ||
    left.linkMethod.localeCompare(right.linkMethod),
  )[0] ?? null;
  return { status: selected ? "automatic" as const : "missing" as const, selected };
}

export type AlertLifecycleState = {
  dedupeKey: string;
  status: "open" | "resolved";
};

export function reconcileAlertLifecycle(
  existing: AlertLifecycleState[],
  currentDedupeKeys: string[],
) {
  const current = new Set(currentDedupeKeys);
  const byKey = new Map(existing.map((alert) => [alert.dedupeKey, alert]));
  for (const dedupeKey of current) byKey.set(dedupeKey, { dedupeKey, status: "open" });
  for (const [dedupeKey, alert] of byKey) {
    if (alert.status === "open" && !current.has(dedupeKey)) {
      byKey.set(dedupeKey, { dedupeKey, status: "resolved" });
    }
  }
  return [...byKey.values()];
}
