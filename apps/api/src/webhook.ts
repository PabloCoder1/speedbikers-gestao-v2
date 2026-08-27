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

/**
 * `/questions/{question_id}` — tópico geral `questions`, confirmado por
 * leitura oficial em D-083 (`docs/MERCADO_LIVRE.md` secao 2.12). Ele dispara
 * tanto para PERGUNTA quanto para RESPOSTA e não traz array `actions`; o
 * detalhe é sempre buscado pelo `resource`, então as duas notificações
 * convergem para o mesmo job.
 */
const QUESTION_RESOURCE_PATTERN = /^\/questions\/(\d+)$/;

/**
 * Tópico tipificado `messages`: diferente de todos os outros, o `resource` é
 * o ID da mensagem CRU, sem barra nem caminho — `"fd1d2e37ad004ede9e0bf25..."`,
 * não `"/messages/fd1d..."` (D-083, secao 2.12). O ID é hexadecimal longo, não
 * numérico, então nada de `Number()` aqui.
 */
const MESSAGE_RESOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export interface WebhookDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export type WebhookOutcome =
  | { status: "enqueued"; jobId: string; jobType: string; deduplicated: boolean }
  | { status: "unknown_account" }
  | { status: "unroutable_resource" }
  | { status: "ignored_action" }
  | { status: "invalid_payload"; reason: string };

interface RoutedJob {
  jobType: string;
  payload: Record<string, unknown>;
}

/**
 * `messages` traz `actions: ["created"]` ou `["read"]`.
 *
 * `read` avisa que a CONTRAPARTE leu uma mensagem — não existe conteúdo novo,
 * e a V3 nem persiste `date_read`. Buscar a conversa inteira nesse caso
 * gastaria um GET do pool compartilhado de 500 rpm da mensageria para gravar
 * exatamente o que já estava gravado. Numa conversa ativa, `read` chega tanto
 * quanto `created`, então isso dobraria o custo sem mudar uma linha do banco.
 *
 * Ausência de `actions` é tratada como conteúdo novo: perder uma mensagem é
 * pior do que um GET a mais.
 */
function isReadOnlyNotification(notification: MercadoLivreNotification): boolean {
  const actions = notification.actions;

  if (actions === undefined || actions.length === 0) {
    return false;
  }

  return actions.every((action) => action.trim().toLowerCase() === "read");
}

/**
 * Decide QUAL job a notificação vira. É a única parte do ACK que conhece
 * tópico — o resto (resolver a conta, dedupe, fila) é igual para todos.
 *
 * `questions` é o primeiro tópico a ganhar job próprio em vez de cair no
 * `sync.webhook.received` genérico (D-087/Fase 7B): o handler de Perguntas já
 * recebe `{ mlAccountId, questionId }` tipado, então extrair o ID aqui evita
 * um segundo parse do mesmo `resource` do outro lado da fila. Enfileirar a
 * partir da `api`, e não do worker que consome `sync.webhook.received`, não é
 * preferência de estilo: o worker só recebe `cloudtasks.enqueuer` em
 * `backfill` e `analytics-recompute` (`docs/ARCHITECTURE.md` secao 11), nunca
 * em `ml-sync-<conta>`, que é a fila onde este job precisa entrar para
 * respeitar o rate limit por conta (D-036).
 *
 * Devolve `null` quando o tópico é conhecido mas o `resource` não tem o
 * formato documentado — não há o que buscar, e mandar para o caminho genérico
 * esconderia a anomalia atrás de um ACK sem trabalho.
 */
function routeJob(notification: MercadoLivreNotification, mlAccountId: string): RoutedJob | null {
  if (notification.topic === "questions") {
    const match = QUESTION_RESOURCE_PATTERN.exec(notification.resource);
    const questionId = match === null ? Number.NaN : Number(match[1]);

    // `Number.isSafeInteger` não é paranoia decorativa: o payload do job
    // valida `questionId` como inteiro positivo, e um `resource` com dígitos
    // demais passaria nessa validação já tendo perdido precisão — viraria uma
    // busca por uma pergunta que não existe, sem erro visível em lugar nenhum.
    if (!Number.isSafeInteger(questionId)) {
      return null;
    }

    return { jobType: "sync.support.questions", payload: { mlAccountId, questionId } };
  }

  if (notification.topic === "messages") {
    if (!MESSAGE_RESOURCE_PATTERN.test(notification.resource)) {
      return null;
    }

    // O job resolve a QUAL conversa a mensagem pertence e persiste a conversa
    // inteira — mensagem solta não traz `conversation_status`, que é de onde
    // sai o estado de resposta do case.
    return {
      jobType: "sync.support.messages",
      payload: { mlAccountId, messageId: notification.resource },
    };
  }

  return { jobType: "sync.webhook.received", payload: { ...notification, mlAccountId } };
}

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

  if (notification.topic === "messages" && isReadOnlyNotification(notification)) {
    deps.logger.info("ml_webhook_read_receipt_ignored", {
      topic: notification.topic,
      ml_account_id: account.data.id,
    });

    return { status: "ignored_action" };
  }

  const job = routeJob(notification, account.data.id);

  if (job === null) {
    // Não é transitório: reenviar o mesmo `resource` malformado não muda o
    // formato. ACK mesmo assim, pelo mesmo motivo de "conta desconhecida" —
    // só logar, para a anomalia ficar visível em vez de virar um job vazio.
    deps.logger.warn("ml_webhook_unroutable_resource", {
      resource: notification.resource,
      topic: notification.topic,
      ml_account_id: account.data.id,
    });

    return { status: "unroutable_resource" };
  }

  const result = await deps.enqueuer.enqueue({
    jobType: job.jobType,
    organizationId: account.data.organization_id,
    // Nome derivado do recurso (docs/ARCHITECTURE.md secao 10): notificações
    // repetidas do mesmo recurso colapsam numa só, seja qual for o tópico.
    // Uma regra de dedupe só, mesmo com mais de um `jobType` — dois tópicos
    // nunca disputam o mesmo `resource`, porque é justamente o formato do
    // `resource` que identifica o tópico.
    dedupeKey: `ml-webhook:${notification.resource}:${window}`,
    queue: `ml-sync-${account.data.slug}`,
    payload: job.payload,
  });

  deps.logger.info("ml_webhook_enqueued", {
    job_id: result.envelope.jobId,
    job_type: job.jobType,
    resource: notification.resource,
    topic: notification.topic,
    ml_account_id: account.data.id,
    deduplicated: result.deduplicated,
  });

  return {
    status: "enqueued",
    jobId: result.envelope.jobId,
    jobType: job.jobType,
    deduplicated: result.deduplicated,
  };
}
