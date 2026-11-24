import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";
import {
  WEBHOOK_CANCELLATION_STATUS_CHANGE,
  WEBHOOK_ORDER_STATUS_CHANGE,
  WEBHOOK_RETURN_STATUS_CHANGE,
  WEBHOOK_SELLER_DEAUTHORIZATION,
  WEBHOOK_UPCOMING_AUTHORIZATION_EXPIRATION,
  parseTikTokWebhookData,
  tiktokWebhookSchema,
  verifyWebhookSignature,
} from "@sb/tiktok-shop";

import type { Enqueuer } from "./enqueue.js";

/**
 * Webhook do TikTok Shop (D-808) — `POST /push/tiktok-shop` (`docs/TIKTOK_SHOP.md` §10):
 *
 * - assinatura verificada ANTES do `JSON.parse` sobre os bytes exatos recebidos:
 *   `HMAC-SHA256(app_secret, app_key + rawBody)` em hex minúsculo no cabeçalho
 *   `Authorization` (sem prefixo `Bearer`), em tempo constante;
 * - assinatura inválida responde HTTP 401 sem efeito colateral;
 * - assinatura válida responde HTTP 200 em até 3 s (corpo vazio), exceto falha
 *   transitória de banco ou fila (HTTP 503 para retentativa do TikTok Shop em
 *   2 min, 30 min, 3 h e 12 h);
 * - coalescência em janela de 5 min (`TIKTOK_PUSH_WINDOW_S`) limita a carga a
 *   12 leituras/hora por loja e deduplica reentregas; sem `enqueuer` (modo
 *   observação antes dos handlers do worker), apenas registra o evento validado.
 */

export const TIKTOK_PUSH_WINDOW_S = 300;

export interface TikTokPushDeps {
  db: AdminClient;
  logger: Logger;
  appKey: string;
  appSecret: string;
  /**
   * Opcional até os handlers `tiktok.orders.sync` e `tiktok.returns.sync`
   * entrarem no worker com suas tabelas versionadas: ausente, o endpoint
   * autentica a assinatura, valida a loja e registra o evento com HTTP 200.
   */
  enqueuer?: Enqueuer;
  now?: () => Date;
}

export type TikTokPushOutcome =
  | { status: "invalid_signature" }
  | { status: "invalid_payload"; reason: string }
  | { status: "ignored"; type: number; notificationId: string; reason: string }
  | { status: "acknowledged"; type: number; notificationId: string; jobType: string }
  | { status: "enqueued"; type: number; notificationId: string; jobType: string; deduplicated: boolean }
  | { status: "unavailable"; reason: string };

const JOB_DO_WEBHOOK: Record<number, { jobType: string; prefixo: string }> = {
  [WEBHOOK_ORDER_STATUS_CHANGE]: { jobType: "tiktok.orders.sync", prefixo: "tiktok-orders-push" },
  [WEBHOOK_CANCELLATION_STATUS_CHANGE]: { jobType: "tiktok.orders.sync", prefixo: "tiktok-orders-push" },
  [WEBHOOK_RETURN_STATUS_CHANGE]: { jobType: "tiktok.returns.sync", prefixo: "tiktok-returns-push" },
};

/**
 * Diagnóstico sem expor assinatura, segredo nem corpo (nomes fora das chaves
 * redigidas pelo logger).
 */
function diagnosticoDaRecusa(input: { rawBody: string; authorization: string | undefined }): Record<string, unknown> {
  const cabecalho = input.authorization;

  return {
    assinatura_presente: cabecalho !== undefined && cabecalho.length > 0,
    assinatura_hex64: cabecalho !== undefined && /^[0-9a-f]{64}$/i.test(cabecalho),
    assinatura_com_bearer: cabecalho !== undefined && /^bearer\s/i.test(cabecalho),
    tamanho_corpo: Buffer.byteLength(input.rawBody, "utf8"),
  };
}

export async function receiveTikTokPush(
  deps: TikTokPushDeps,
  input: { rawBody: string; authorization: string | undefined },
): Promise<TikTokPushOutcome> {
  if (!verifyWebhookSignature(deps.appSecret, deps.appKey, input.rawBody, input.authorization)) {
    deps.logger.warn("tiktok_push_rejected", diagnosticoDaRecusa(input));

    return { status: "invalid_signature" };
  }

  let corpo: unknown;

  try {
    corpo = JSON.parse(input.rawBody);
  } catch {
    deps.logger.warn("tiktok_push_invalid_payload", { reason: "json inválido" });

    return { status: "invalid_payload", reason: "json inválido" };
  }

  const lido = tiktokWebhookSchema.safeParse(corpo);

  if (!lido.success) {
    deps.logger.warn("tiktok_push_invalid_payload", { reason: "envelope fora do contrato" });

    return { status: "invalid_payload", reason: "envelope fora do contrato" };
  }

  const push = lido.data;

  if (push.type === WEBHOOK_SELLER_DEAUTHORIZATION || push.type === WEBHOOK_UPCOMING_AUTHORIZATION_EXPIRATION) {
    const detalhe = parseTikTokWebhookData(push.type, push.data);

    deps.logger.warn("tiktok_push_authorization_event", {
      type: push.type,
      tts_notification_id: push.tts_notification_id,
      shop_id: push.shop_id ?? null,
      ...(detalhe?.kind === "upcoming_authorization_expiration" ? { expiration_time: detalhe.expirationTime } : {}),
    });

    return {
      status: "ignored",
      type: push.type,
      notificationId: push.tts_notification_id,
      reason: "evento de autorização registrado",
    };
  }

  const job = Object.hasOwn(JOB_DO_WEBHOOK, push.type) ? JOB_DO_WEBHOOK[push.type] : undefined;

  if (job === undefined) {
    deps.logger.info("tiktok_push_ignored", {
      type: push.type,
      tts_notification_id: push.tts_notification_id,
      shop_id: push.shop_id ?? null,
    });

    return { status: "ignored", type: push.type, notificationId: push.tts_notification_id, reason: "evento sem ação" };
  }

  if (push.shop_id === undefined) {
    deps.logger.warn("tiktok_push_invalid_payload", {
      type: push.type,
      tts_notification_id: push.tts_notification_id,
      reason: "shop_id ausente",
    });

    return { status: "invalid_payload", reason: "shop_id ausente" };
  }

  const lida = await deps.db
    .from("tiktok_shops")
    .select("id, organization_id, status")
    .eq("shop_id", push.shop_id)
    .maybeSingle();

  if (lida.error !== null) {
    deps.logger.error("tiktok_push_shop_lookup_failed", {
      type: push.type,
      tts_notification_id: push.tts_notification_id,
      shop_id: push.shop_id,
      reason: lida.error.message,
    });

    return { status: "unavailable", reason: lida.error.message };
  }

  const loja = lida.data;

  if (loja?.status !== "CONNECTED") {
    deps.logger.info("tiktok_push_ignored", {
      type: push.type,
      tts_notification_id: push.tts_notification_id,
      shop_id: push.shop_id,
      motivo: loja === null ? "loja desconhecida" : "loja não conectada",
    });

    return {
      status: "ignored",
      type: push.type,
      notificationId: push.tts_notification_id,
      reason: loja === null ? "loja desconhecida" : "loja não conectada",
    };
  }

  const detalhe = parseTikTokWebhookData(push.type, push.data);

  if (deps.enqueuer === undefined) {
    deps.logger.info("tiktok_push_acknowledged", {
      type: push.type,
      tts_notification_id: push.tts_notification_id,
      shop_id: push.shop_id,
      tiktok_shop_id: loja.id,
      job_type: job.jobType,
      ...(detalhe !== null && "orderId" in detalhe ? { order_id: detalhe.orderId } : {}),
    });

    return {
      status: "acknowledged",
      type: push.type,
      notificationId: push.tts_notification_id,
      jobType: job.jobType,
    };
  }

  const agoraMs = (deps.now?.() ?? new Date()).getTime();
  const agoraS = Number.isFinite(agoraMs) ? Math.floor(agoraMs / 1000) : Math.floor(Date.now() / 1000);
  const fimDaJanela = (Math.floor(agoraS / TIKTOK_PUSH_WINDOW_S) + 1) * TIKTOK_PUSH_WINDOW_S;

  try {
    const result = await deps.enqueuer.enqueue({
      jobType: job.jobType,
      organizationId: loja.organization_id,
      dedupeKey: `${job.prefixo}:${loja.id}:${String(fimDaJanela)}`,
      queue: "backfill",
      payload: { tiktokShopId: loja.id, notificationId: push.tts_notification_id },
      delaySeconds: fimDaJanela - agoraS,
    });

    deps.logger.info("tiktok_push_enqueued", {
      type: push.type,
      tts_notification_id: push.tts_notification_id,
      shop_id: push.shop_id,
      tiktok_shop_id: loja.id,
      job_type: job.jobType,
      deduplicated: result.deduplicated,
    });

    return {
      status: "enqueued",
      type: push.type,
      notificationId: push.tts_notification_id,
      jobType: job.jobType,
      deduplicated: result.deduplicated,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "falha ao enfileirar";

    deps.logger.error("tiktok_push_enqueue_failed", {
      type: push.type,
      tts_notification_id: push.tts_notification_id,
      shop_id: push.shop_id,
      reason,
    });

    return { status: "unavailable", reason };
  }
}
