import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { processClaimReturn } from "./claim-return.js";
import { ensureAccessToken } from "./ml-token.js";
import { orderSchema } from "./order-schema.js";
import { persistOrder } from "./persist-order.js";

/**
 * Fast Path do webhook — `sync.webhook.received`, achado em revisão
 * (2026-08-22, `docs/ROADMAP.md` Fase 3): até aqui o job era enfileirado
 * pelo ACK rápido (`apps/api/src/webhook.ts`) mas nunca tinha handler
 * registrado — esgotava as tentativas do Cloud Tasks e era descartado, sem
 * efeito. `docs/MERCADO_LIVRE.md` secao 3 já previa este handler como o
 * caminho PRINCIPAL de frescor ("a V3 nasce com o webhook como caminho
 * principal e o cron rebaixado a reconciliação") — não era uma feature
 * nova, era uma peça que faltava.
 *
 * `orders_v2` e `post_purchase` estão implementados — os únicos dois
 * tópicos com consumidor pronto (`persistOrder`, `processClaimReturn`).
 * Outros tópicos (`items`, `shipments`, `questions`, `stock-location`,
 * etc.) fazem ACK sem trabalho — mesmo raciocínio de "conta desconhecida"
 * em `webhook.ts`: não é erro, só não há consumidor ainda.
 *
 * Reconciliação por janela continua como rede de segurança (papel que já
 * tem hoje) — este handler não a substitui, só reduz o frescor do caminho
 * feliz de "até 1h" para "segundos".
 */

const payloadSchema = z.object({
  mlAccountId: z.uuid(),
  resource: z.string().min(1),
  topic: z.string().min(1),
});

export interface WebhookReceivedDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
}

/** `/orders/{order_id}` — confirmado em `docs/MERCADO_LIVRE.md` secao 2.4 e nos fixtures reais de `webhook.test.ts`. */
const ORDER_RESOURCE_PATTERN = /^\/orders\/(\d+)$/;

/** `/post-purchase/v1/claims/{claim_id}` — confirmado em `docs/MERCADO_LIVRE.md` secao 2.10 (leitura ao vivo, 2026-08-23). */
const CLAIM_RESOURCE_PATTERN = /^\/post-purchase\/v1\/claims\/(\d+)$/;

export function createWebhookReceivedHandler(deps: WebhookReceivedDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem mlAccountId/resource/topic" };
    }

    const { mlAccountId, resource, topic } = parsed.data;

    if (topic !== "orders_v2" && topic !== "post_purchase") {
      // Sem consumidor para este tópico ainda — ACK sem trabalho, não é erro.
      return { status: "done", processed: 0 };
    }

    const resourcePattern = topic === "orders_v2" ? ORDER_RESOURCE_PATTERN : CLAIM_RESOURCE_PATTERN;
    const match = resourcePattern.exec(resource);

    if (match === null) {
      // Cada tópico tem um formato fixo de `resource` — um formato diferente
      // é inesperado o bastante para não valer retry.
      return { status: "failed", retryable: false, reason: `resource fora do formato esperado: ${resource}` };
    }

    const resourceId = match[1] ?? "";

    const account = await deps.db
      .from("ml_accounts")
      .select("organization_id, status")
      .eq("id", mlAccountId)
      .maybeSingle();

    if (account.error !== null || account.data === null) {
      context.logger.warn("webhook_fast_path_account_missing", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    if (account.data.status !== "CONNECTED") {
      // Desconectada entre o webhook e a execução — corrida benigna, mesmo
      // raciocínio de sync.orders.window.
      return { status: "done", processed: 0 };
    }

    const now = deps.now?.() ?? new Date();
    const tokenResult = await ensureAccessToken(deps, mlAccountId, now);

    if (!tokenResult.ok) {
      return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
    }

    if (topic === "post_purchase") {
      let processed: number;

      try {
        processed = await processClaimReturn(
          deps,
          { organizationId: account.data.organization_id, mlAccountId },
          tokenResult.accessToken,
          resourceId,
          now,
          context.logger,
        );
      } catch (error) {
        const errorClass = error instanceof MercadoLivreApiError ? error.errorClass : "retryable";
        const reason = error instanceof Error ? error.message : "erro desconhecido ao buscar a reclamação";

        return { status: "failed", retryable: errorClass !== "not_retryable", reason };
      }

      context.logger.info("webhook_fast_path_claim_done", { ml_account_id: mlAccountId, claim_id: resourceId });

      return { status: "done", processed };
    }

    let order;

    try {
      order = await deps.mercadoLivre.request({
        method: "GET",
        path: `/orders/${resourceId}`,
        accessToken: tokenResult.accessToken,
        schema: orderSchema,
      });
    } catch (error) {
      const errorClass = error instanceof MercadoLivreApiError ? error.errorClass : "retryable";
      const reason = error instanceof Error ? error.message : "erro desconhecido ao buscar o pedido";

      return { status: "failed", retryable: errorClass !== "not_retryable", reason };
    }

    await persistOrder(
      deps.db,
      { organizationId: account.data.organization_id, mlAccountId },
      order,
      context.logger,
    );

    context.logger.info("webhook_fast_path_done", { ml_account_id: mlAccountId, order_id: resourceId });

    return { status: "done", processed: 1 };
  };
}
