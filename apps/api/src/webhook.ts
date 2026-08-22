import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";
import { z } from "zod";

import type { Enqueuer } from "./enqueue.js";

/**
 * Recepção do webhook do Mercado Livre.
 *
 * ACK rápido, zero chamada à API do Mercado Livre (`docs/MERCADO_LIVRE.md`
 * secao 2.4, `docs/API.md` secao 2). "Zero chamada de rede" é sobre NÃO
 * chamar o Mercado Livre no caminho do ACK — não sobre evitar o próprio
 * Postgres: uma busca indexada por `seller_id` é rápida e do mesmo tipo já
 * aceito em outras rotas da `api` (`auth.ts`).
 *
 * "Grava a notificação e cria uma Cloud Task" (secao 10 de
 * `docs/ARCHITECTURE.md`) é cumprido pelo PRÓPRIO corpo da Cloud Task: não
 * existe tabela de landing para a notificação crua — decisão registrada em
 * D-044, já que nenhum documento definia isso antes desta implementação.
 */

/**
 * Formato confirmado por leitura direta de
 * `developers.mercadolivre.com.br/pt_br/produto-receba-notificacoes`
 * (`docs/MERCADO_LIVRE.md` secao 2.4). Tópicos "simples" usam `_id`; tópicos
 * com subtópico (`messages`, `vis_leads`, `post_purchase`) às vezes usam `id`
 * no lugar e trazem `actions`. Aceitar os dois evita rejeitar notificação
 * válida por causa de um campo que não usamos.
 */
export const mercadoLivreNotificationSchema = z.object({
  _id: z.string().optional(),
  id: z.string().optional(),
  resource: z.string().min(1),
  topic: z.string().min(1),
  user_id: z.coerce.number().int(),
  application_id: z.coerce.number().int().optional(),
  attempts: z.number().int().optional(),
  sent: z.string().optional(),
  received: z.string().optional(),
  actions: z.array(z.string()).optional(),
});

export type MercadoLivreNotification = z.infer<typeof mercadoLivreNotificationSchema>;

export interface WebhookDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export type WebhookOutcome =
  | { status: "enqueued"; jobId: string; deduplicated: boolean }
  | { status: "unknown_account" }
  | { status: "invalid_payload"; reason: string };

export async function receiveWebhook(deps: WebhookDeps, rawBody: unknown): Promise<WebhookOutcome> {
  const parsed = mercadoLivreNotificationSchema.safeParse(rawBody);

  if (!parsed.success) {
    return {
      status: "invalid_payload",
      reason: parsed.error.issues[0]?.message ?? "payload inválido",
    };
  }

  const notification = parsed.data;

  // Papel confiável NÃO vem da notificação (qualquer um pode alegar um
  // seller_id) — vem de existir uma conta nossa com esse seller_id. A
  // validação de origem por IP (D-043) já garante que a chamada veio do
  // Mercado Livre; isto aqui só resolve QUAL conta.
  const account = await deps.db
    .from("ml_accounts")
    .select("id, organization_id, slug")
    .eq("seller_id", notification.user_id)
    .maybeSingle();

  if (account.error !== null || account.data === null) {
    // Não é transitório: reprocessar não vai criar a conta. ACK mesmo assim
    // (ver receiveWebhook em webhook.ts e o handler da rota) — só logar.
    deps.logger.warn("ml_webhook_unknown_account", {
      seller_id: notification.user_id,
      topic: notification.topic,
    });

    return { status: "unknown_account" };
  }

  // Sufixo de janela de minuto (D-051): sem ele, duas notificações do MESMO
  // recurso — uma delas uma mudança de status real, não um reenvio — dentro
  // das 24h em que o Cloud Tasks pode reter o nome de uma task já executada
  // colidiriam, e a segunda seria descartada como ALREADY_EXISTS. Notificações
  // repetidas do mesmo recurso ainda colapsam numa só DENTRO do mesmo minuto
  // (o caso real de reenvio por falta de ACK a tempo); uma mudança de status
  // seguinte, minutos depois, gera um job novo — achado em revisão, 2026-08-22.
  const window = (deps.now?.() ?? new Date()).toISOString().slice(0, 16);

  const result = await deps.enqueuer.enqueue({
    jobType: "sync.webhook.received",
    organizationId: account.data.organization_id,
    // Nome derivado do recurso (docs/ARCHITECTURE.md secao 10): notificações
    // repetidas do mesmo recurso colapsam numa só, seja qual for o tópico.
    dedupeKey: `ml-webhook:${notification.resource}:${window}`,
    queue: `ml-sync-${account.data.slug}`,
    payload: { ...notification, mlAccountId: account.data.id },
  });

  deps.logger.info("ml_webhook_enqueued", {
    job_id: result.envelope.jobId,
    resource: notification.resource,
    topic: notification.topic,
    ml_account_id: account.data.id,
    deduplicated: result.deduplicated,
  });

  return { status: "enqueued", jobId: result.envelope.jobId, deduplicated: result.deduplicated };
}
