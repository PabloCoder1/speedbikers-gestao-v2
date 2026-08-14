import "server-only";

import { MERCADO_LIVRE_URLS } from "@/integrations/mercado-livre/constants";

const DEFAULT_TIMEOUT_MS = 15_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function readInteger(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export class MercadoLivreFulfillmentRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly responseCode: string | null,
    public readonly responseMessage: string | null,
    public readonly retryable: boolean,
    public readonly staleOrNotApplicable: boolean,
  ) {
    super(message);
    this.name = "MercadoLivreFulfillmentRequestError";
  }
}

async function mercadoLivreGet({ path, accessToken, timeoutMs }: { path: string; accessToken: string; timeoutMs: number }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${MERCADO_LIVRE_URLS.api}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await response.text();
    let payload: unknown = null;
    try { payload = body ? JSON.parse(body) : null; } catch { payload = null; }
    if (!response.ok) {
      const errorPayload = isObject(payload) ? payload : {};
      const responseCode = readString(errorPayload.error) ?? readString(errorPayload.code);
      const responseMessage = readString(errorPayload.message) ?? (body.slice(0, 300) || null);
      const stale = response.status === 404 && (responseCode === "seller_product_not_found" || responseCode === "not_found");
      throw new MercadoLivreFulfillmentRequestError(
        `FULFILLMENT_HTTP_${response.status}:${responseCode ?? "unknown"}`,
        response.status,
        responseCode,
        responseMessage,
        response.status === 429 || response.status >= 500,
        stale,
      );
    }
    if (!isObject(payload)) throw new MercadoLivreFulfillmentRequestError("FULFILLMENT_INVALID_RESPONSE", response.status, null, null, false, false);
    return payload;
  } catch (error) {
    if (error instanceof MercadoLivreFulfillmentRequestError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new MercadoLivreFulfillmentRequestError("FULFILLMENT_TIMEOUT", null, "timeout", error.message, true, false);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function getMercadoLivreFulfillmentStock({
  inventoryId,
  accessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  inventoryId: string;
  accessToken: string;
  timeoutMs?: number;
}) {
  const normalizedId = inventoryId.trim();
  if (!normalizedId) throw new Error("inventory_id_required");
  const raw = await mercadoLivreGet({
    path: `/inventories/${encodeURIComponent(normalizedId)}/stock/fulfillment`,
    accessToken,
    timeoutMs,
  });
  const total = readInteger(raw.total);
  const availableQuantity = readInteger(raw.available_quantity);
  const notAvailableQuantity = readInteger(raw.not_available_quantity);
  if (total === null || availableQuantity === null || notAvailableQuantity === null) {
    throw new MercadoLivreFulfillmentRequestError("FULFILLMENT_INVALID_QUANTITIES", 200, null, null, false, false);
  }
  return {
    raw,
    normalized: {
      inventoryId: readString(raw.inventory_id) ?? normalizedId,
      total,
      availableQuantity,
      notAvailableQuantity,
      notAvailableDetail: Array.isArray(raw.not_available_detail) ? raw.not_available_detail : [],
      externalReferences: Array.isArray(raw.external_references) ? raw.external_references : [],
    },
  };
}

export async function getMercadoLivreFulfillmentOperation({
  operationId,
  accessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  operationId: string;
  accessToken: string;
  timeoutMs?: number;
}) {
  const normalizedId = operationId.trim();
  if (!normalizedId) throw new Error("operation_id_required");
  const raw = await mercadoLivreGet({
    path: `/stock/fulfillment/operations/${encodeURIComponent(normalizedId)}`,
    accessToken,
    timeoutMs,
  });
  return {
    raw,
    normalized: {
      operationId: readString(raw.id) ?? normalizedId,
      sellerId: readString(raw.seller_id),
      inventoryId: readString(raw.inventory_id) ?? readString(raw.seller_product_id),
      operationType: readString(raw.type),
      externalReferences: Array.isArray(raw.external_references) ? raw.external_references : [],
    },
  };
}
