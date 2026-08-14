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
