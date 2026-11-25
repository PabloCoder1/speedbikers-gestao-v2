import { z } from "zod";

/**
 * Contratos compartilhados de fila do TikTok Shop (D-812, `M04`).
 *
 * Assim como `webhook-topics.ts` (D-179), estes nomes de job, schemas de
 * payload e geradores de `dedupeKey` vivem em `@sb/contracts` para garantir
 * que `apps/api` (emissor via webhook e Cloud Scheduler) e `apps/worker`
 * (consumidor) nunca divirjam em nome de fila, chave de coalescência ou
 * formato do payload.
 */

/** Janela de coalescência dos webhooks TikTok Shop (5 min -> máx. 12 leituras/h por loja). */
export const TIKTOK_PUSH_WINDOW_S = 300;

/** Atraso do sync de catálogo após o de pedidos no gatilho horário (evita disputa pela trava de refresh). */
export const TIKTOK_ITEMS_DELAY_S = 300;

export const TIKTOK_JOB_TYPES = {
  ordersSync: "tiktok.orders.sync",
  itemsSync: "tiktok.items.sync",
  orderFetch: "tiktok.order.fetch",
  returnsSync: "tiktok.returns.sync",
  financialsSync: "tiktok.financials.sync",
} as const;

export type TikTokJobType = (typeof TIKTOK_JOB_TYPES)[keyof typeof TIKTOK_JOB_TYPES];

export const TIKTOK_JOB_TYPE_LIST: readonly TikTokJobType[] = [
  TIKTOK_JOB_TYPES.ordersSync,
  TIKTOK_JOB_TYPES.itemsSync,
  TIKTOK_JOB_TYPES.orderFetch,
  TIKTOK_JOB_TYPES.returnsSync,
  TIKTOK_JOB_TYPES.financialsSync,
];

const TIKTOK_JOB_TYPE_SET: ReadonlySet<string> = new Set(TIKTOK_JOB_TYPE_LIST);

export function isTikTokJobType(value: string): value is TikTokJobType {
  return TIKTOK_JOB_TYPE_SET.has(value);
}

const nonEmptyTrimmedId = (max: number) => z.string().trim().min(1).max(max);

export const tiktokOrdersSyncPayloadSchema = z.object({
  tiktokShopId: z.uuid(),
  notificationId: nonEmptyTrimmedId(128).optional(),
});

export const tiktokItemsSyncPayloadSchema = z.object({
  tiktokShopId: z.uuid(),
});

export const tiktokOrderFetchPayloadSchema = z.object({
  tiktokShopId: z.uuid(),
  orderId: nonEmptyTrimmedId(64),
  notificationId: nonEmptyTrimmedId(128).optional(),
});

export const tiktokReturnsSyncPayloadSchema = z.object({
  tiktokShopId: z.uuid(),
  notificationId: nonEmptyTrimmedId(128).optional(),
});

export const tiktokFinancialsSyncPayloadSchema = z.object({
  tiktokShopId: z.uuid(),
  orderId: nonEmptyTrimmedId(64).optional(),
});

export type TikTokOrdersSyncPayload = z.infer<typeof tiktokOrdersSyncPayloadSchema>;
export type TikTokItemsSyncPayload = z.infer<typeof tiktokItemsSyncPayloadSchema>;
export type TikTokOrderFetchPayload = z.infer<typeof tiktokOrderFetchPayloadSchema>;
export type TikTokReturnsSyncPayload = z.infer<typeof tiktokReturnsSyncPayloadSchema>;
export type TikTokFinancialsSyncPayload = z.infer<typeof tiktokFinancialsSyncPayloadSchema>;

export interface TikTokJobPayloadMap {
  [TIKTOK_JOB_TYPES.ordersSync]: TikTokOrdersSyncPayload;
  [TIKTOK_JOB_TYPES.itemsSync]: TikTokItemsSyncPayload;
  [TIKTOK_JOB_TYPES.orderFetch]: TikTokOrderFetchPayload;
  [TIKTOK_JOB_TYPES.returnsSync]: TikTokReturnsSyncPayload;
  [TIKTOK_JOB_TYPES.financialsSync]: TikTokFinancialsSyncPayload;
}

const PAYLOAD_SCHEMAS: Readonly<Record<TikTokJobType, z.ZodType>> = {
  [TIKTOK_JOB_TYPES.ordersSync]: tiktokOrdersSyncPayloadSchema,
  [TIKTOK_JOB_TYPES.itemsSync]: tiktokItemsSyncPayloadSchema,
  [TIKTOK_JOB_TYPES.orderFetch]: tiktokOrderFetchPayloadSchema,
  [TIKTOK_JOB_TYPES.returnsSync]: tiktokReturnsSyncPayloadSchema,
  [TIKTOK_JOB_TYPES.financialsSync]: tiktokFinancialsSyncPayloadSchema,
};

export type TikTokJobParseResult =
  | { success: true; jobType: TikTokJobType; data: TikTokJobPayloadMap[TikTokJobType] }
  | { success: false; reason: string };

export function parseTikTokJobPayload(jobType: string, payload: unknown): TikTokJobParseResult {
  if (!isTikTokJobType(jobType) || !Object.hasOwn(PAYLOAD_SCHEMAS, jobType)) {
    return { success: false, reason: `tipo de job TikTok desconhecido: ${jobType}` };
  }

  const parsed = PAYLOAD_SCHEMAS[jobType].safeParse(payload);

  if (!parsed.success) {
    return { success: false, reason: parsed.error.issues[0]?.message ?? "payload TikTok inválido" };
  }

  return {
    success: true,
    jobType,
    data: parsed.data as TikTokJobPayloadMap[TikTokJobType],
  };
}

export interface TikTokPushWindowBucket {
  nowSeconds: number;
  bucketEndSeconds: number;
  delaySeconds: number;
}

/**
 * Calcula o fim do balde de coalescência e o atraso até ele (em segundos).
 * Falha fechado com `RangeError` se `now` ou `windowSeconds` forem inválidos.
 */
export function tiktokPushWindowBucket(
  now: Date,
  windowSeconds: number = TIKTOK_PUSH_WINDOW_S,
): TikTokPushWindowBucket {
  const nowMs = now.getTime();

  if (!Number.isFinite(nowMs)) {
    throw new RangeError("instante inválido para janela de push TikTok Shop");
  }

  if (!Number.isSafeInteger(windowSeconds) || windowSeconds <= 0) {
    throw new RangeError("tamanho de janela inválido para push TikTok Shop");
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  const bucketEndSeconds = (Math.floor(nowSeconds / windowSeconds) + 1) * windowSeconds;

  return {
    nowSeconds,
    bucketEndSeconds,
    delaySeconds: bucketEndSeconds - nowSeconds,
  };
}

function requireNonEmptyId(value: string, label: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new RangeError(`${label} obrigatório para dedupeKey TikTok Shop`);
  }

  return trimmed;
}

function requireNonNegativeEpochSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("bucketEndSeconds inválido para dedupeKey TikTok Shop");
  }

  return value;
}

const HOUR_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/;

function requireHourPrefix(hourIsoPrefix: string): string {
  const match = HOUR_PREFIX_RE.exec(hourIsoPrefix);

  if (match === null) {
    throw new RangeError(`prefixo horário inválido: ${hourIsoPrefix}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23) {
    throw new RangeError(`prefixo horário fora do calendário: ${hourIsoPrefix}`);
  }

  const check = new Date(Date.UTC(year, month - 1, day, hour));

  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour
  ) {
    throw new RangeError(`data inexistente no calendário: ${hourIsoPrefix}`);
  }

  return hourIsoPrefix;
}

const PUSH_PREFIX: Readonly<Record<"tiktok.orders.sync" | "tiktok.returns.sync", string>> = {
  "tiktok.orders.sync": "tiktok-orders-push",
  "tiktok.returns.sync": "tiktok-returns-push",
};

const SCHEDULE_PREFIX: Readonly<
  Record<"tiktok.orders.sync" | "tiktok.items.sync" | "tiktok.returns.sync" | "tiktok.financials.sync", string>
> = {
  "tiktok.orders.sync": "tiktok-orders",
  "tiktok.items.sync": "tiktok-items",
  "tiktok.returns.sync": "tiktok-returns",
  "tiktok.financials.sync": "tiktok-financials",
};

export function tiktokPushDedupeKey(
  jobType: "tiktok.orders.sync" | "tiktok.returns.sync",
  tiktokShopId: string,
  bucketEndSeconds: number,
): string {
  const shopId = requireNonEmptyId(tiktokShopId, "tiktokShopId");
  const end = requireNonNegativeEpochSeconds(bucketEndSeconds);

  return `${PUSH_PREFIX[jobType]}:${shopId}:${String(end)}`;
}

export function tiktokScheduleDedupeKey(
  jobType: "tiktok.orders.sync" | "tiktok.items.sync" | "tiktok.returns.sync" | "tiktok.financials.sync",
  tiktokShopId: string,
  hourIsoPrefix: string,
): string {
  const shopId = requireNonEmptyId(tiktokShopId, "tiktokShopId");
  const hora = requireHourPrefix(hourIsoPrefix);

  return `${SCHEDULE_PREFIX[jobType]}:${shopId}:hora:${hora}`;
}

export function tiktokOrderFetchDedupeKey(
  tiktokShopId: string,
  orderId: string,
  bucketEndSeconds: number,
): string {
  const shopId = requireNonEmptyId(tiktokShopId, "tiktokShopId");
  const cleanOrderId = requireNonEmptyId(orderId, "orderId");
  const end = requireNonNegativeEpochSeconds(bucketEndSeconds);

  return `tiktok-order-fetch:${shopId}:${cleanOrderId}:${String(end)}`;
}
