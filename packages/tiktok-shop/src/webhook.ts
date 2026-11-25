import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { MAX_UNIX_EPOCH_SECONDS } from "./auth.js";

/**
 * Webhooks do TikTok Shop (D-807) — P`tts-webhooks-overview` e
 * P`configuration-guide`, conferidos em `docs/TIKTOK_SHOP.md` §10:
 *
 * - cabeçalho `Authorization` SEM "Bearer": HMAC-SHA256 hex minúsculo de
 *   `app_key + corpo bruto` com a chave `app_secret`;
 * - verificado sobre os bytes recebidos ANTES de qualquer JSON.parse, em tempo
 *   constante;
 * - entrega "pelo menos uma vez", deduplicada por `tts_notification_id`;
 * - o webhook só aciona a sincronização: o worker relê pela API e nunca confia
 *   no texto de status enviado no push.
 */

export const WEBHOOK_ORDER_STATUS_CHANGE = 1;
export const WEBHOOK_SELLER_DEAUTHORIZATION = 6;
export const WEBHOOK_UPCOMING_AUTHORIZATION_EXPIRATION = 7;
export const WEBHOOK_CANCELLATION_STATUS_CHANGE = 11;
export const WEBHOOK_RETURN_STATUS_CHANGE = 12;
export const WEBHOOK_INVOICE_STATUS_CHANGE = 36;

const inteiroSeguro = z.union([
  z.number().int().refine(Number.isSafeInteger, "inteiro fora da faixa segura"),
  z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .refine(Number.isSafeInteger, "inteiro fora da faixa segura"),
]);

const epochSegundos = inteiroSeguro.refine(
  (valor) => valor > 0 && valor <= MAX_UNIX_EPOCH_SECONDS,
  "timestamp fora da faixa segura",
);

const shopIdSchema = z.union([
  z.string().regex(/^[0-9]{1,30}$/, "shop_id inválido"),
  z
    .number()
    .int()
    .positive()
    .refine(Number.isSafeInteger, "shop_id fora da faixa segura")
    .transform(String),
]);

/** Envelope comum de webhook do TikTok Shop (§10). */
export const tiktokWebhookSchema = z.looseObject({
  type: inteiroSeguro,
  tts_notification_id: z.string().trim().min(1),
  shop_id: shopIdSchema.optional(),
  timestamp: epochSegundos.optional(),
  data: z.unknown().optional(),
});

export type TikTokWebhook = z.infer<typeof tiktokWebhookSchema>;

/** Calcula a assinatura esperada: `HMAC-SHA256(appSecret, appKey + rawBody)` em hex minúsculo. */
export function signWebhook(appSecret: string, appKey: string, rawBody: string): string {
  return createHmac("sha256", appSecret).update(`${appKey}${rawBody}`).digest("hex");
}

/**
 * Verifica o cabeçalho `Authorization` do TikTok Shop em tempo constante sobre
 * o corpo bruto recebido. Rejeita segredo/chave vazios, ausência de cabeçalho,
 * prefixo `Bearer` e hex malformado.
 */
export function verifyWebhookSignature(
  appSecret: string,
  appKey: string,
  rawBody: string,
  authorization: string | undefined,
): boolean {
  if (appSecret.length === 0 || appKey.length === 0 || authorization === undefined) return false;
  if (!/^[0-9a-f]{64}$/i.test(authorization)) return false;

  const esperado = Buffer.from(signWebhook(appSecret, appKey, rawBody), "hex");
  const recebido = Buffer.from(authorization.toLowerCase(), "hex");

  return esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
}

const orderStatusDataSchema = z.object({
  order_id: z.string().trim().min(1),
  order_status: z.string().trim().min(1),
  is_on_hold_order: z.boolean().optional(),
  update_time: epochSegundos.optional(),
});

const cancellationDataSchema = z.object({
  cancel_id: z.string().trim().min(1),
  order_id: z.string().trim().min(1),
  cancel_status: z.string().trim().min(1),
  update_time: epochSegundos.optional(),
});

const returnDataSchema = z.object({
  return_id: z.string().trim().min(1),
  order_id: z.string().trim().min(1),
  return_status: z.string().trim().min(1),
  update_time: epochSegundos.optional(),
});

const authExpirationDataSchema = z.object({
  expiration_time: epochSegundos.optional(),
  message: z.string().optional(),
});

export type TikTokWebhookParsedData =
  | {
      readonly kind: "order_status_change";
      readonly orderId: string;
      readonly orderStatus: string;
      readonly isOnHoldOrder: boolean | null;
      readonly updateTime: number | null;
    }
  | {
      readonly kind: "cancellation_status_change";
      readonly cancelId: string;
      readonly orderId: string;
      readonly cancelStatus: string;
      readonly updateTime: number | null;
    }
  | {
      readonly kind: "return_status_change";
      readonly returnId: string;
      readonly orderId: string;
      readonly returnStatus: string;
      readonly updateTime: number | null;
    }
  | {
      readonly kind: "upcoming_authorization_expiration";
      readonly expirationTime: number | null;
      readonly message: string | null;
    };

/** Extrai o sub-payload tipado para eventos conhecidos, devolvendo `null` quando desconhecido ou incompleto. */
export function parseTikTokWebhookData(type: number, data: unknown): TikTokWebhookParsedData | null {
  if (type === WEBHOOK_ORDER_STATUS_CHANGE) {
    const parsed = orderStatusDataSchema.safeParse(data);

    if (!parsed.success) return null;

    return {
      kind: "order_status_change",
      orderId: parsed.data.order_id,
      orderStatus: parsed.data.order_status,
      isOnHoldOrder: parsed.data.is_on_hold_order ?? null,
      updateTime: parsed.data.update_time ?? null,
    };
  }

  if (type === WEBHOOK_CANCELLATION_STATUS_CHANGE) {
    const parsed = cancellationDataSchema.safeParse(data);

    if (!parsed.success) return null;

    return {
      kind: "cancellation_status_change",
      cancelId: parsed.data.cancel_id,
      orderId: parsed.data.order_id,
      cancelStatus: parsed.data.cancel_status,
      updateTime: parsed.data.update_time ?? null,
    };
  }

  if (type === WEBHOOK_RETURN_STATUS_CHANGE) {
    const parsed = returnDataSchema.safeParse(data);

    if (!parsed.success) return null;

    return {
      kind: "return_status_change",
      returnId: parsed.data.return_id,
      orderId: parsed.data.order_id,
      returnStatus: parsed.data.return_status,
      updateTime: parsed.data.update_time ?? null,
    };
  }

  if (type === WEBHOOK_UPCOMING_AUTHORIZATION_EXPIRATION) {
    const parsed = authExpirationDataSchema.safeParse(data);

    if (!parsed.success) return null;

    return {
      kind: "upcoming_authorization_expiration",
      expirationTime: parsed.data.expiration_time ?? null,
      message: parsed.data.message ?? null,
    };
  }

  return null;
}
