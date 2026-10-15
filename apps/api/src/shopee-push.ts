import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";
import {
  PUSH_AUTHORIZATION_CANCELED,
  PUSH_ORDER_STATUS,
  PUSH_RETURN_UPDATES,
  shopeePushSchema,
  verifyPushSignature,
  type ShopeeEnvironment,
} from "@sb/shopee";

import type { Enqueuer } from "./enqueue.js";

/**
 * Push da Shopee (D-453): o aviso de que um pedido ou uma devolução mudou
 * ANTECIPA a sincronização da loja — quem lê o dado continua sendo o job de
 * sempre (`shopee.orders.sync`, `shopee.returns.sync`), pela API. O gatilho
 * de hora em hora segue como rede: o push não tem entrega garantida.
 *
 * - Assinatura: HMAC da chave do parceiro sobre `<endereço cadastrado>|<corpo
 *   cru>`. Push sem assinatura válida é IGNORADO, mas recebe 2xx: a
 *   verificação do endereço no Console não diz se vem assinada, e responder
 *   erro só baixaria a taxa de sucesso que a Shopee usa para desligar a
 *   assinatura. Nada é feito com ele.
 * - Os avisos de uma loja numa janela de 5 minutos viram UMA leitura, no fim
 *   da janela (a mesma chave de deduplicação com atraso até o fim dela): o
 *   primeiro aviso agenda, os seguintes caem na mesma tarefa, nenhum se perde
 *   e a carga fica limitada a 12 leituras por hora por loja.
 * - Autorização cancelada (código 2) só vai para o log: os exemplos da
 *   documentação se contradizem no formato (`shop_id`, `shopid`, listas), e
 *   a renovação do token já marca a loja quando a Shopee recusa.
 */

/** A janela que junta os avisos de uma loja numa leitura. */
export const PUSH_JANELA_S = 300;

export interface ShopeePushDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  environment: ShopeeEnvironment;
  partnerKey: string;
  /** O endereço EXATO cadastrado no Console: entra na assinatura. */
  pushUrl: string;
  now?: () => Date;
}

export type ShopeePushOutcome =
  | { status: "invalid_signature" }
  | { status: "invalid_payload"; reason: string }
  | { status: "ignored"; code: number; reason: string }
  | { status: "enqueued"; code: number; jobType: string; deduplicated: boolean }
  // Falha passageira ao ler a loja ou enfileirar: a Shopee repete.
  | { status: "unavailable"; reason: string };

const JOB_DO_PUSH: Record<number, { jobType: string; prefixo: string }> = {
  [PUSH_ORDER_STATUS]: { jobType: "shopee.orders.sync", prefixo: "shopee-orders-push" },
  [PUSH_RETURN_UPDATES]: { jobType: "shopee.returns.sync", prefixo: "shopee-returns-push" },
};

export async function receiveShopeePush(
  deps: ShopeePushDeps,
  input: { rawBody: string; authorization: string | undefined },
): Promise<ShopeePushOutcome> {
  if (!verifyPushSignature(deps.partnerKey, deps.pushUrl, input.rawBody, input.authorization)) {
    deps.logger.warn("shopee_push_signature_rejected", { has_authorization: input.authorization !== undefined });

    return { status: "invalid_signature" };
  }

  let corpo: unknown;

  try {
    corpo = JSON.parse(input.rawBody) as unknown;
  } catch {
    return { status: "invalid_payload", reason: "corpo não é JSON" };
  }

  const parsed = shopeePushSchema.safeParse(corpo);

  if (!parsed.success) {
    return { status: "invalid_payload", reason: "push sem code" };
  }

  const push = parsed.data;

  if (push.code === PUSH_AUTHORIZATION_CANCELED) {
    deps.logger.warn("shopee_push_authorization_canceled", { code: push.code, shop_id: push.shop_id ?? null, data: push.data ?? null });

    return { status: "ignored", code: push.code, reason: "autorização cancelada: só registrada" };
  }

  const job = JOB_DO_PUSH[push.code];

  if (job === undefined) {
    deps.logger.info("shopee_push_ignored", { code: push.code, shop_id: push.shop_id ?? null });

    return { status: "ignored", code: push.code, reason: "push sem ação" };
  }

  if (push.shop_id === undefined) {
    return { status: "invalid_payload", reason: "push de loja sem shop_id" };
  }

  const lida = await deps.db
    .from("shopee_shops")
    .select("id, organization_id, status")
    .eq("environment", deps.environment)
    .eq("shop_id", push.shop_id)
    .maybeSingle();

  if (lida.error !== null) {
    deps.logger.error("shopee_push_shop_lookup_failed", { code: push.code, shop_id: push.shop_id, reason: lida.error.message });

    return { status: "unavailable", reason: lida.error.message };
  }

  const loja = lida.data;

  if (loja?.status !== "CONNECTED") {
    deps.logger.info("shopee_push_ignored", {
      code: push.code,
      shop_id: push.shop_id,
      motivo: loja === null ? "loja desconhecida" : "loja não conectada",
    });

    return { status: "ignored", code: push.code, reason: loja === null ? "loja desconhecida" : "loja não conectada" };
  }

  const agoraS = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
  const fimDaJanela = (Math.floor(agoraS / PUSH_JANELA_S) + 1) * PUSH_JANELA_S;

  try {
    const result = await deps.enqueuer.enqueue({
      jobType: job.jobType,
      organizationId: loja.organization_id,
      dedupeKey: `${job.prefixo}:${loja.id}:${String(fimDaJanela)}`,
      queue: "backfill",
      payload: { shopeeShopId: loja.id },
      delaySeconds: fimDaJanela - agoraS,
    });

    deps.logger.info("shopee_push_enqueued", {
      code: push.code,
      shop_id: push.shop_id,
      shopee_shop_id: loja.id,
      job_type: job.jobType,
      deduplicated: result.deduplicated,
    });

    return { status: "enqueued", code: push.code, jobType: job.jobType, deduplicated: result.deduplicated };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "falha ao enfileirar";

    deps.logger.error("shopee_push_enqueue_failed", { code: push.code, shop_id: push.shop_id, reason });

    return { status: "unavailable", reason };
  }
}
