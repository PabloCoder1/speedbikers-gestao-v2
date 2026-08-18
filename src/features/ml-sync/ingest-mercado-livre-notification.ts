import "server-only";

import { createHash } from "node:crypto";

import {
  getMercadoLivreConfig,
  type MercadoLivreAppCode,
} from "@/integrations/mercado-livre/config";
import { resourceTarget } from "@/features/ml-sync/notification-resource";
import { createAdminClient } from "@/lib/supabase/admin";

const SUPPORTED_TOPICS = new Set([
  "items_prices",
  "public_offers",
  "fbm_stock_operations",
  "orders_v2",
]);

type EnqueueStatus =
  | "queued"
  | "duplicate"
  | "unknown_account";

export type MercadoLivreNotificationIngestResult = {
  status: EnqueueStatus | "ignored";
  reason?: string;
  notificationId: string | null;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function readInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value;
}

function readDate(value: unknown) {
  const text = readString(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readExactDigits(rawBody: string, key: string) {
  const escapedKey = escapeRegExp(key);
  const match = rawBody.match(
    new RegExp(`"${escapedKey}"\\s*:\\s*(?:"([0-9]+)"|([0-9]+))`),
  );
  return match?.[1] ?? match?.[2] ?? null;
}

function applicationCode(applicationId: string): MercadoLivreAppCode | null {
  const { apps } = getMercadoLivreConfig();
  for (const code of Object.keys(apps) as MercadoLivreAppCode[]) {
    if (apps[code].clientId === applicationId) return code;
  }
  return null;
}

function notificationKey({
  notificationId,
  topic,
  resource,
  sellerId,
  sentAt,
  rawBody,
}: {
  notificationId: string | null;
  topic: string;
  resource: string;
  sellerId: string;
  sentAt: string | null;
  rawBody: string;
}) {
  if (notificationId) return `ml:${topic}:${notificationId}`;
  const rawSuffix = sentAt
    ? ""
    : `:${createHash("sha256").update(rawBody).digest("hex")}`;
  return createHash("sha256")
    .update(`${topic}:${resource}:${sellerId}:${sentAt ?? ""}${rawSuffix}`)
    .digest("hex");
}

export async function ingestMercadoLivreNotification({
  rawBody,
  receivedAt = new Date().toISOString(),
}: {
  rawBody: string;
  receivedAt?: string;
}): Promise<MercadoLivreNotificationIngestResult> {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: "ignored", reason: "invalid_json", notificationId: null };
  }

  if (!isObject(payload)) {
    return { status: "ignored", reason: "invalid_payload", notificationId: null };
  }

  const topic = readString(payload.topic);
  const notificationId = readString(payload._id) ?? readString(payload.id);
  if (!topic || !SUPPORTED_TOPICS.has(topic)) {
    return { status: "ignored", reason: "unsupported_topic", notificationId };
  }

  const applicationId = readExactDigits(rawBody, "application_id");
  const sellerId = readExactDigits(rawBody, "user_id");
  if (!applicationId || !sellerId) {
    return { status: "ignored", reason: "missing_identity", notificationId };
  }

  const appCode = applicationCode(applicationId);
  if (!appCode) {
    return { status: "ignored", reason: "unknown_application", notificationId };
  }

  const resource = readString(payload.resource);
  const target = resource ? resourceTarget(topic, resource) : null;
  if (!resource || !target) {
    return { status: "ignored", reason: "invalid_resource", notificationId };
  }

  const sentAt = readDate(payload.sent);
  const key = notificationKey({
    notificationId,
    topic,
    resource,
    sellerId,
    sentAt,
    rawBody,
  });
  const admin = createAdminClient();
  if (topic === "fbm_stock_operations") {
    const { data, error } = await admin.rpc(
      "enqueue_ml_fulfillment_refresh_notification",
      {
        requested_app_code: appCode,
        requested_seller_id: sellerId,
        requested_notification_key: key,
        requested_notification_id: notificationId,
        requested_operation_id: target.operationId,
        requested_application_id: applicationId,
        requested_resource: resource,
        requested_raw_body: rawBody,
      },
    );
    if (error) throw new Error(`FULFILLMENT_NOTIFICATION_ENQUEUE_FAILED: ${error.message}`);
    if (data !== "queued" && data !== "duplicate" && data !== "unknown_account") {
      throw new Error("FULFILLMENT_NOTIFICATION_ENQUEUE_INVALID_RESULT");
    }
    return { status: data as EnqueueStatus, notificationId };
  }

  if (topic === "orders_v2") {
    // Lightweight by construction: this branch only ever calls
    // admin.rpc(...) to enqueue a job. No Mercado Livre API call, no
    // order persistence, no metrics rebuild happens in the webhook —
    // that all runs later in process-order-refresh-job.ts.
    const { data, error } = await admin.rpc(
      "enqueue_ml_order_refresh_notification",
      {
        requested_app_code: appCode,
        requested_seller_id: sellerId,
        requested_order_id: target.orderId,
        requested_notification_key: key,
        requested_notification_id: notificationId,
        requested_resource: resource,
        requested_application_id: applicationId,
        requested_raw_body: rawBody,
      },
    );
    if (error) throw new Error(`ORDER_NOTIFICATION_ENQUEUE_FAILED: ${error.message}`);
    if (data !== "queued" && data !== "duplicate" && data !== "unknown_account") {
      throw new Error("ORDER_NOTIFICATION_ENQUEUE_INVALID_RESULT");
    }
    return { status: data as EnqueueStatus, notificationId };
  }

  const { data, error } = await admin.rpc(
    "enqueue_ml_offer_refresh_notification",
    {
      requested_app_code: appCode,
      requested_seller_id: sellerId,
      requested_topic: topic,
      requested_resource: resource,
      requested_item_id: target.itemId,
      requested_offer_id: target.offerId,
      requested_notification_key: key,
      requested_notification_id: notificationId,
      requested_application_id: applicationId,
      requested_notification_attempts: readInteger(payload.attempts),
      requested_sent_at: sentAt,
      requested_received_at: receivedAt,
      requested_raw_body: rawBody,
    },
  );

  if (error) {
    throw new Error(`NOTIFICATION_ENQUEUE_FAILED: ${error.message}`);
  }

  if (data !== "queued" && data !== "duplicate" && data !== "unknown_account") {
    throw new Error("NOTIFICATION_ENQUEUE_INVALID_RESULT");
  }

  return {
    status: data as EnqueueStatus,
    notificationId,
  };
}
